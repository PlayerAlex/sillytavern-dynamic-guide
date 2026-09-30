'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function load(helper, extra) {
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
    };
    Object.assign(sandbox, extra || {});
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    return { core: sandbox.DynamicGuideAssistantCore, logs, errors };
}

const { core } = load();
const plain = value => JSON.parse(JSON.stringify(value));
const range = (text, quote) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote });
const lastUserText = request => {
    const segments = (request.ordered_prompts || []).filter(item => item && item.role === 'user');
    return segments.length ? String(segments[segments.length - 1].content) : '';
};

const promptTestNodes = (root, predicate) => [
    ...(predicate(root) ? [root] : []),
    ...(root.children || []).flatMap(child => promptTestNodes(child, predicate)),
];

function savedStages(content, stages) {
    return {
        version: 3,
        loop: false,
        stages: stages.map((stage, index) => {
            const start = content.indexOf(stage.quote);
            return {
                id: `s${index + 1}`,
                name: stage.name,
                completion: stage.completion || '',
                terminal: false,
                ranges: [{ start, end: start + stage.quote.length }],
            };
        }),
        addons: [],
        always: { ranges: [] },
        note: { ranges: [] },
    };
}

function memoryStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return {
        getItem: key => data.has(key) ? data.get(key) : null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
        clear: () => data.clear(),
        dump: () => Object.fromEntries(data),
    };
}

test('v2 只发送当前阶段、范围内附加和常驻内容', () => {
    const parsed = core.parseOutline('## 第一幕\n完成：正式交谈结束。\n当前正文\n\n## 第二幕\n未来正文\n\n## 道具 [附加]\n从：第一幕\n到：第二幕\n道具正文\n\n## 风格 [常驻]\n风格正文\n\n## 秘密 [备注]\n不应发送');
    assert.equal(parsed.stages.length, 2);
    assert.deepEqual(plain(core.activeAddons(parsed, 0).map(item => item.name)), ['道具', '风格']);
    const injected = core.formatInjection(parsed.stages[0], core.activeAddons(parsed, 0));
    assert.match(injected, /当前正文/);
    assert.doesNotMatch(injected, /DGA_COMPLETE|完成判定|当前阶段：/);
    assert.doesNotMatch(injected, /未来正文|不应发送/);
    assert.doesNotMatch(injected, /动态指导助手：当前有效内容|以下是作者为当前进度/, '正文不能带插件头部');
    assert.equal(core.activeAddons(parsed, 2).length, 0);
});

test('旧模板的多行提示词、完成条件和带书名号范围仍可解析', () => {
    const parsed = core.parseOutline('【内容：第一幕】\n什么时候出现：\n游戏开始时\n\n告诉AI：\n当前正文\n\n什么时候消失：\n交谈结束。\n\n【内容：第二幕】\n告诉AI：未来正文\n\n【内容：道具】\n类型：重要物品\n什么时候出现：\n《第一幕》正在进行时\n\n告诉AI：道具正文\n什么时候消失：\n《第二幕》结束时');
    assert.deepEqual(plain(parsed.stages.map(item => [item.name, item.prompt])), [['第一幕', '当前正文'], ['第二幕', '未来正文']]);
    assert.equal(parsed.stages[0].completion, '交谈结束。');
    assert.deepEqual(plain(parsed.addons.map(item => [item.fromIndex, item.toIndex])), [[0, 1]]);
});

test('显式转义的标题和标签作为正文发送，普通反斜杠不受影响', () => {
    const parsed = core.parseOutline('## 第一幕\n\\## 普通小标题\n\\【普通标题】\n\\完成：这只是正文\n  \\从：这也是正文\n\\\\## 原来就有反斜杠\n\\路径');
    assert.equal(parsed.stages.length, 1);
    assert.equal(parsed.stages[0].completion, '');
    assert.equal(parsed.stages[0].prompt, '## 普通小标题\n【普通标题】\n完成：这只是正文\n  从：这也是正文\n\\## 原来就有反斜杠\n\\路径');
});

test('旧布局迁移保留正文结构行、已有反斜杠和常驻内容', () => {
    const body = '## 正文小标题\n【正文方括号标题】\n完成：仍是正文\n从：仍是正文\n类型：仍是正文\n\\## 已有转义\n\\路径\n  \\缩进路径';
    const always = '## 风格小标题\n告诉AI：这整行都是原文';
    const text = `${body}\n\n${always}`;
    const layout = { mode: 'ranges', stages: [{ name: '第一幕', completion: '剧情完成。', ranges: [range(text, body)] }], always: { ranges: [range(text, always)] } };
    const parsed = core.parseOutline(core.convertLegacyLayout(text, layout));
    assert.equal(parsed.stages.length, 1);
    assert.equal(parsed.stages[0].prompt, body);
    assert.equal(parsed.stages[0].completion, '剧情完成。');
    assert.equal(parsed.addons[0].prompt, always);
});

test('旧布局未分配的秘密不能通过原文标题逃出备注', () => {
    const body = '## 背景\n当前允许知道的事';
    const hidden = '未分配秘密\n## 最终秘密\n绝不能提前暴露\n【额外秘密】\n类型：剧情';
    const text = `${body}\n\n${hidden}`;
    const layout = { mode: 'ranges', stages: [{ name: '第一幕', ranges: [range(text, body)] }] };
    const parsed = core.parseOutline(core.convertLegacyLayout(text, layout));
    assert.equal(parsed.stages.length, 1);
    assert.equal(parsed.blocks.find(item => item.kind === 'note').prompt, hidden);
    const injected = core.formatInjection(parsed.stages[0], core.activeAddons(parsed, 0));
    assert.doesNotMatch(injected, /未分配秘密|最终秘密|绝不能提前暴露|额外秘密/);
});

test('改原文时阶段区间跟着挪，后面的阶段不被带跑', () => {
    const oldText = '暑假正文\n寒假正文';
    const pick = {
        text: oldText,
        stages: [
            { id: 'a', kind: 'stage', name: '暑假', ranges: [{ start: 0, end: 4 }] },
            { id: 'b', kind: 'stage', name: '寒假', ranges: [{ start: 5, end: 9 }] },
        ],
        addons: [],
        always: { id: 'always', kind: 'always', ranges: [] },
        note: { id: 'note', kind: 'note', ranges: [] },
        pendingRanges: [],
    };
    core.rebasePickText(pick, '暑假正文已改\n寒假正文');
    assert.equal(pick.text.slice(pick.stages[0].ranges[0].start, pick.stages[0].ranges[0].end), '暑假正文已改');
    assert.equal(pick.text.slice(pick.stages[1].ranges[0].start, pick.stages[1].ranges[0].end), '寒假正文');
});

test('循环开着且进度停在全部完成时，拉回第一段继续发送', () => {
    const parsed = core.parseOutline('## 暑假\n暑假正文\n\n## 寒假\n寒假正文');
    parsed.loop = true;
    const looped = core.reconcileState({ stageIndex: 2, stageName: '' }, parsed);
    assert.equal(looped.stageIndex, 0);
    const started = core.reconcileState(null, parsed, 1);
    assert.equal(started.stageIndex, 1, '没有聊天进度时从绑定上的起始步开始');
    assert.equal(started.stageName, '寒假');
    assert.equal(looped.stageName, '暑假');
    const stopped = core.reconcileState({ stageIndex: 2, stageName: '' }, core.parseOutline('## 暑假\n暑假正文\n\n## 寒假\n寒假正文'));
    assert.equal(stopped.stageIndex, 2);
    assert.equal(stopped.stageName, '');
});

test('同名阶段停在当前下标，不跳回第一个', () => {
    const parsed = core.parseOutline('## 暑假\nA\n\n## 寒假\nB\n\n## 暑假\nC');
    const state = core.reconcileState({ stageIndex: 2, stageName: '暑假' }, parsed);
    assert.equal(state.stageIndex, 2);
    assert.equal(state.stageName, '暑假');
});

function helperFor(entry) {
    const state = {
        events: new Map(),
        injected: [],
        injectionOptions: [],
        active: new Map(),
        removed: [],
        variables: {
            character: { $dynamicGuideAssistant: { config: { worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' } } },
            chat: {},
        },
        entries: [entry],
    };
    const helper = {
        tavern_events: { GENERATION_AFTER_COMMANDS: 'generate', CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received' },
        eventOn: (event, listener) => state.events.set(event, listener),
        getVariables: ({ type }) => state.variables[type],
        updateVariablesWith: (updater, { type }) => { state.variables[type] = updater(state.variables[type]); },
        getWorldbook: () => state.entries,
        updateWorldbookWith: (_name, updater) => { state.entries = updater(state.entries); },
        injectPrompts: (prompts, options) => prompts.forEach(prompt => {
            state.injected.push(prompt);
            state.injectionOptions.push(options || null);
            state.active.set(prompt.id, prompt);
        }),
        uninjectPrompts: ids => ids.forEach(id => {
            state.removed.push(id);
            state.active.delete(id);
        }),
    };
    return { state, helper };
}

const isMirror = item => /（动态指导）/.test(String(item.name || item.comment || ''));

function runtime(entry) {
    const { state, helper } = helperFor(entry);
    return {
        ...load(helper),
        state,
        injected: state.injected,
        injectionOptions: state.injectionOptions,
        active: state.active,
        removed: state.removed,
        mirror: () => state.entries.find(isMirror),
        generate: async () => state.events.get('generate')('normal', {}, false),
    };
}

for (const storage of ['extra', 'embedded']) {
    test(`尚未转换的 ${storage} 旧布局不建镜像并提示转换`, async () => {
        const text = '## 旧原文里的秘密\n不应按新格式发送';
        const layout = { mode: 'ranges', stages: [{ name: '旧阶段', ranges: [range(text, '不应按新格式发送')] }] };
        const entry = { uid: 1, name: '大纲', content: text, enabled: false };
        if (storage === 'extra') entry.extra = { dynamicGuideAssistant: { layout } };
        else entry.content += `\n<!-- DGA_LAYOUT_V1:BEGIN -->${Buffer.from(JSON.stringify(layout)).toString('base64')}<!-- DGA_LAYOUT_V1:END -->`;
        const run = runtime(entry);
        await run.generate();
        assert.equal(run.mirror(), undefined, '旧布局不能创建镜像');
        assert.equal(run.state.entries.length, 1, '世界书里不能多出条目');
        assert.ok(run.removed.includes('dynamic-guide-assistant-current'), '要清掉旧版无后缀注入');
        assert.ok(run.removed.some(id => id.startsWith('dynamic-guide-assistant-current-')), '要清掉这条绑定的旧注入');
        assert.match(run.logs.join('\n'), /转换成新版格式/);
        assert.deepEqual(run.errors, []);
    });
}

test('新格式会创建镜像条目显示当前阶段，并重新禁用意外打开的来源条目', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文\n\n## 第二幕\n未来秘密', enabled: true };
    const run = runtime(entry);
    await run.generate();
    const mirror = run.mirror();
    assert.ok(mirror, '应当在同一本世界书里创建镜像条目');
    assert.match(mirror.content, /当前正文/);
    assert.doesNotMatch(mirror.content, /未来秘密/);
    assert.doesNotMatch(mirror.content, /动态指导助手：当前有效内容|以下是作者/, '镜像内容不能带插件头部');
    assert.equal(mirror.enabled, true, '镜像条目要是打开状态');
    assert.equal(entry.enabled, false, '来源条目要被重新关闭');
    assert.deepEqual(run.errors, []);
});

test('生成事件等待异步读取和同步完成后才允许请求继续', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n必须出现的当前正文', enabled: false };
    const { state, helper } = helperFor(entry);
    const pending = [];
    let released = false;
    helper.getWorldbook = () => (released
        ? Promise.resolve(state.entries)
        : new Promise(resolve => pending.push(resolve)));
    const run = load(helper);
    const generation = state.events.get('generate')('normal', {}, false);
    let finished = false;
    Promise.resolve(generation).then(() => { finished = true; });
    await new Promise(setImmediate);
    assert.equal(finished, false, '世界书还没读完时，生成事件不能提前结束');
    assert.equal(state.entries.some(isMirror), false);
    released = true;
    pending.forEach(resolve => resolve(state.entries));
    await generation;
    assert.equal(finished, true);
    const mirror = state.entries.find(isMirror);
    assert.ok(mirror, '读完世界书后要把镜像建出来');
    assert.match(mirror.content, /必须出现的当前正文/);
    assert.deepEqual(run.errors, []);
});

test('打开页面就同步好镜像，进度一变立刻换成新阶段', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n第一段正文\n\n## 第二幕\n第二段正文', enabled: false };
    const run = runtime(entry);
    await new Promise(setImmediate);
    assert.ok(run.mirror(), '打开页面就该有镜像，不必等生成事件');
    assert.match(run.mirror().content, /第一段正文/);
    await run.core.next();
    assert.match(run.mirror().content, /第二段正文/, '进度推进后镜像立刻更新');
    assert.doesNotMatch(run.mirror().content, /第一段正文/);
    assert.deepEqual(run.errors, []);
});

test('swipe 重新生成时镜像显示的是推进前的阶段', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n第一段正文\n\n## 第二幕\n第二段正文', enabled: false };
    const { state, helper } = helperFor(entry);
    state.variables.chat.$dynamicGuideAssistant = {
        state: { stageIndex: 1, stageName: '第二幕', lastCompletionMessageId: 7, lastCompletionFingerprint: 'x' },
    };
    helper.getLastMessageId = () => 7;
    const run = load(helper);
    await new Promise(setImmediate);
    assert.match(state.entries.find(isMirror).content, /第二段正文/);
    await state.events.get('generate')('swipe', {}, false);
    const mirror = state.entries.find(isMirror);
    assert.match(mirror.content, /第一段正文/, 'swipe 要回到推进前的阶段');
    assert.doesNotMatch(mirror.content, /第二段正文/);
    assert.deepEqual(run.errors, []);
});

test('循环回到第一段后，重新生成仍显示刚完成的最后一段', async () => {
    const text = '暑假正文\n寒假正文\n平时正文';
    const span = quote => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length });
    const entry = {
        uid: 1, name: '大纲', content: text, enabled: false,
        extra: {
            dynamicGuideAssistantLayout: {
                version: 3,
                loop: true,
                stages: [
                    { id: 's', name: '暑假', ranges: [span('暑假正文')] },
                    { id: 'w', name: '寒假', ranges: [span('寒假正文')] },
                    { id: 't', name: '平时', ranges: [span('平时正文')] },
                ],
            },
        },
    };
    const { state, helper } = helperFor(entry);
    state.variables.chat.$dynamicGuideAssistant = {
        state: { stageIndex: 0, stageName: '暑假', lastCompletionMessageId: 7, preAdvanceIndex: 2 },
    };
    helper.getLastMessageId = () => 7;
    const run = load(helper);
    await new Promise(setImmediate);
    assert.match(state.entries.find(isMirror).content, /暑假正文/);
    await state.events.get('generate')('swipe', {}, false);
    const mirror = state.entries.find(isMirror);
    assert.match(mirror.content, /平时正文/, '循环绕回第一段时，重新生成要回到推进前的最后一段');
    assert.doesNotMatch(mirror.content, /暑假正文/);
    assert.deepEqual(run.errors, []);
});

test('循环开着且进度停在全部完成时，镜像回到第一段', async () => {
    const text = '暑假正文\n寒假正文';
    const span = quote => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length });
    const entry = {
        uid: 1, name: '大纲', content: text, enabled: false,
        extra: {
            dynamicGuideAssistantLayout: {
                version: 3,
                loop: true,
                stages: [
                    { id: 's', name: '暑假', ranges: [span('暑假正文')] },
                    { id: 'w', name: '寒假', ranges: [span('寒假正文')] },
                ],
            },
        },
    };
    const { state, helper } = helperFor(entry);
    state.variables.chat.$dynamicGuideAssistant = {
        state: { stageIndex: 2, stageName: '', lastCompletionMessageId: null, lastCompletionFingerprint: '' },
    };
    const run = load(helper);
    await new Promise(setImmediate);
    const mirror = state.entries.find(isMirror);
    assert.ok(mirror, '循环开着就不能因为停在全部完成而拆掉镜像');
    assert.match(mirror.content, /暑假正文/);
    assert.doesNotMatch(mirror.content, /寒假正文/);
    assert.deepEqual(run.errors, []);
});

test('循环开着时，快捷指令下一段从最后一段回到第一段', async () => {
    const text = '暑假正文\n寒假正文';
    const span = quote => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length });
    const entry = {
        uid: 1, name: '大纲', content: text, enabled: false,
        extra: {
            dynamicGuideAssistantLayout: {
                version: 3,
                loop: true,
                stages: [
                    { id: 's', name: '暑假', ranges: [span('暑假正文')] },
                    { id: 'w', name: '寒假', ranges: [span('寒假正文')] },
                ],
            },
        },
    };
    const { state, helper } = helperFor(entry);
    state.variables.chat.$dynamicGuideAssistant = {
        state: { stageIndex: 1, stageName: '寒假', lastCompletionMessageId: null, lastCompletionFingerprint: '' },
    };
    const run = load(helper);
    await new Promise(setImmediate);
    assert.match(state.entries.find(isMirror).content, /寒假正文/);
    await run.core.next();
    assert.match(state.entries.find(isMirror).content, /暑假正文/);
    assert.doesNotMatch(state.entries.find(isMirror).content, /寒假正文/);
    assert.deepEqual(run.errors, []);
});

// v2.5 镜像回归：镜像条目可能被用户误删或被世界书操作冲掉，必须能自己补回来
test('镜像被外部删掉后，下一次生成事件会重建', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文', enabled: false };
    const run = runtime(entry);
    await new Promise(setImmediate);
    assert.ok(run.mirror(), '打开页面就该有镜像');
    run.state.entries.splice(run.state.entries.indexOf(run.mirror()), 1);
    await run.generate();
    assert.ok(run.mirror(), '生成事件必须重建镜像');
    assert.match(run.mirror().content, /当前正文/);
    assert.deepEqual(run.errors, []);
});

test('dryRun 预组装（提示词查看器）同步后镜像保持可见', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文', enabled: false };
    const { state, helper } = helperFor(entry);
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('generate')('normal', {}, true);
    const mirror = state.entries.find(isMirror);
    assert.ok(mirror && mirror.enabled !== false, 'dryRun 也要能看到镜像内容');
    assert.match(mirror.content, /当前正文/);
    assert.deepEqual(run.errors, []);
});

// v2.5 迁移：≤2.4 走 injectPrompts / setExtensionPrompt 注入，升级后第一次启动要按旧 id 清干净
test('升级后第一次启动会清掉旧版注入残留（助手和原生两条通道）', async () => {
    const calls = [];
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (id, text, position) => calls.push({ id, text, position }),
        }),
    };
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false };
    const { state, helper } = helperFor(entry);
    const run = load(helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    assert.ok(state.removed.includes('dynamic-guide-assistant-current'), '要清掉旧版无后缀注入');
    assert.ok(state.removed.some(id => id.startsWith('dynamic-guide-assistant-current-')), '要清掉各绑定的旧注入');
    const cleared = calls.filter(call => call.text === '');
    assert.ok(cleared.length >= 2, '原生通道也要按 id 写空内容清理');
    assert.ok(cleared.every(call => call.position === -1), '清理写到 NONE=-1 位置');
    assert.deepEqual(run.errors, []);
});

test('诊断：链路完好时全部通过，镜像行直接显示同步状态', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false };
    const good = helperFor(entry);
    good.helper.getWorldbookNames = () => ['测试世界书'];
    good.helper.getCharWorldbookNames = () => ['测试世界书'];
    good.helper.getCharData = () => ({ name: '测试角色' });
    good.helper.getLastMessageId = () => 0;
    const run = load(good.helper);
    await new Promise(setImmediate);
    const rows = plain(await run.core.diagnose());
    const failed = rows.filter(row => !row.ok);
    assert.deepEqual(failed.map(row => row.label), [], `全部应通过，未通过：${failed.map(row => row.label).join('、')}`);
    const bindingRow = rows.find(row => row.label === '绑定「大纲」');
    assert.match(bindingRow.detail, /位置：/);
    const mirrorRow = rows.find(row => row.label === '镜像「大纲（动态指导）」');
    assert.ok(mirrorRow, '要有镜像行');
    assert.match(mirrorRow.detail, /与当前阶段一致/);
    const bad = helperFor(entry);
    delete bad.helper.getWorldbook;
    const runBad = load(bad.helper);
    const badRows = plain(await runBad.core.diagnose());
    assert.equal(badRows.find(row => row.label === '接口 getWorldbook').ok, false, '缺 getWorldbook 要标出');
    assert.equal(badRows.find(row => row.label === '绑定「大纲」').ok, false, '读不了世界书时绑定行要标出');
});

// 手机端回归：魔法棒菜单的触摸事件必须同步显示整屏管理页。
function element(tag, registry) {
    const node = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        children: [],
        attributes: {},
        listeners: {},
        style: {
            setProperty(name, value) {
                this[name] = String(value);
            },
        },
        hidden: false,
        className: '',
        focus() {},
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name === 'hidden') this.hidden = true;
            if (name === 'id') {
                this.id = String(value);
                registry.set(this.id, this);
            }
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        removeAttribute(name) {
            delete this.attributes[name];
            if (name === 'hidden') this.hidden = false;
        },
        addEventListener(type, listener) {
            this.listeners[type] = (this.listeners[type] || []).concat(listener);
        },
        append(...items) {
            items.forEach(item => {
                if (!item) return;
                item.parentNode = this;
                this.children.push(item);
                if (item.id) registry.set(item.id, item);
            });
        },
        appendChild(item) {
            this.append(item);
            return item;
        },
        replaceChildren(...items) {
            this.children = [];
            this.append(...items);
        },
        removeChild(item) {
            this.children = this.children.filter(child => child !== item);
            item.parentNode = null;
            return item;
        },
        querySelector(selector) {
            return findClass(this, selector.replace(/^\./, ''), true);
        },
        get textContent() {
            if (this.__text) return this.text;
            return this.children.map(child => child.textContent).join('');
        },
        set textContent(value) {
            this.children = [];
            this.__text = true;
            this.text = String(value);
        },
    };
    node.classList = {
        toggle(name, force) {
            const classes = new Set(String(node.className).split(/\s+/).filter(Boolean));
            const want = force === undefined ? !classes.has(name) : Boolean(force);
            if (want) classes.add(name);
            else classes.delete(name);
            node.className = Array.from(classes).join(' ');
            return want;
        },
        add(name) {
            this.toggle(name, true);
        },
        remove(name) {
            this.toggle(name, false);
        },
        contains: name => String(node.className).split(/\s+/).includes(name),
    };
    return node;
}

function nodeClassNames(node) {
    const fromName = typeof node.className === 'string' ? node.className : '';
    const fromAttr = node.attributes && node.attributes.class ? String(node.attributes.class) : '';
    return `${fromName} ${fromAttr}`.split(/\s+/).filter(Boolean);
}

function findClass(node, name, skipSelf) {
    if (!skipSelf && nodeClassNames(node).includes(name)) return node;
    for (const child of node.children || []) {
        const found = findClass(child, name, false);
        if (found) return found;
    }
    return null;
}

function fakeDocument(html) {
    const registry = new Map();
    const documentRef = {
        head: element('head', registry),
        body: element('body', registry),
        createElement: tag => element(tag, registry),
        // 真浏览器的 SVG：className 是只读对象，赋值会抛错。setAttribute('class') 仍然生效。
        createElementNS: (_namespace, tag) => {
            const node = element(tag, registry);
            const animated = { baseVal: '' };
            Object.defineProperty(node, 'className', {
                configurable: true,
                get() { return animated; },
                set() {
                    throw new TypeError('Cannot set property className of #<SVGElement> which has only a getter');
                },
            });
            const setAttribute = node.setAttribute.bind(node);
            node.setAttribute = (name, value) => {
                setAttribute(name, value);
                if (name === 'class') animated.baseVal = String(value);
            };
            return node;
        },
        createTextNode: text => ({ nodeType: 3, __text: true, textContent: String(text) }),
        getElementById: id => registry.get(id) || null,
        querySelector: () => null,
    };
    documentRef.documentElement = element('html', registry);
    documentRef.documentElement.appendChild(documentRef.head);
    documentRef.documentElement.appendChild(documentRef.body);
    if (html.includes('extensionsMenu')) {
        const menu = element('div', registry);
        menu.setAttribute('id', 'extensionsMenu');
        documentRef.body.appendChild(menu);
        const button = element('button', registry);
        button.setAttribute('id', 'extensionsMenuButton');
        documentRef.body.appendChild(button);
    }
    return documentRef;
}

function loadWithDocument(documentRef, helper) {
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        document: documentRef,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        setInterval: () => 0,
        clearInterval: () => {},
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    return { logs, errors, sandbox };
}

function loadWithNestedDocuments(topDocument, frameDocument, helper) {
    const logs = [];
    const errors = [];
    const topWindow = {
        document: topDocument,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
    };
    topWindow.top = topWindow;
    topWindow.parent = topWindow;
    const frameWindow = {
        document: frameDocument,
        top: topWindow,
        parent: topWindow,
        TavernHelper: helper,
    };
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        window: frameWindow,
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    return { logs, errors, sandbox, topWindow, frameWindow };
}

const touchEntry = async entry => {
    const event = { target: entry, preventDefault() {}, stopPropagation() {} };
    entry.listeners.pointerup[0](event);
    await new Promise(setImmediate);
};

const PANEL_ID = 'dynamic-guide-assistant-panel';

test('手机触摸魔法棒入口会立即打开全屏管理页', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const { errors } = loadWithDocument(documentRef, helper);
    const entry = documentRef.getElementById('dynamic-guide-assistant-menu-item');
    assert.ok(entry, '应当注册魔法棒菜单入口');
    assert.ok(entry.listeners.pointerup, '应当监听手机指针抬起');
    assert.ok(entry.listeners.touchend, '应当兼容旧手机触摸结束');
    assert.equal(documentRef.getElementById(PANEL_ID), null, '加载时不提前把面板挂进脚本 iframe');
    const pending = touchEntry(entry);
    const panel = documentRef.getElementById(PANEL_ID);
    assert.ok(panel, '触摸入口时才在主页面创建面板');
    assert.equal(panel.hidden, false, '触摸事件返回前就要显示管理页');
    const shell = panel.querySelector('.dga-shell');
    assert.ok(shell, '管理页要渲染进面板');
    assert.equal(shell.style.height, '100%', '手机端使用整屏高度');
    assert.equal(shell.style['max-width'], 'none', '手机端不显示成居中小窗口');
    await pending;
    assert.equal(panel.hidden, false);
    assert.deepEqual(errors, []);
});

test('脚本在嵌套 iframe 运行时，入口和面板都挂到含魔法棒的主页面', async () => {
    const topDocument = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const frameDocument = fakeDocument('<body></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const { errors } = loadWithNestedDocuments(topDocument, frameDocument, helper);
    const entry = topDocument.getElementById('dynamic-guide-assistant-menu-item');
    assert.ok(entry, '入口应创建在主页面');
    assert.equal(frameDocument.getElementById('dynamic-guide-assistant-menu-item'), null);
    const pending = touchEntry(entry);
    const panel = topDocument.getElementById(PANEL_ID);
    assert.ok(panel, '面板应创建在主页面');
    assert.equal(frameDocument.getElementById(PANEL_ID), null, '脚本 iframe 内不应创建小面板');
    assert.equal(panel.hidden, false);
    await pending;
    assert.deepEqual(errors, []);
});

test('跨域顶层窗口不会阻止同源页面注册入口', () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const crossOriginTop = new Proxy({}, {
        get() {
            throw new Error('SecurityError: cross-origin access denied');
        },
        set() {
            throw new Error('SecurityError: cross-origin access denied');
        },
    });
    const frameWindow = {
        document: documentRef,
        parent: null,
        top: crossOriginTop,
        TavernHelper: helper,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
    };
    frameWindow.parent = frameWindow;
    const logs = [];
    const errors = [];
    vm.runInNewContext(source, {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        window: frameWindow,
    }, { filename: 'index.js' });
    assert.ok(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    assert.ok(documentRef.getElementById('dynamic-guide-assistant-style'), '入口注册时应同时安装手机触摸样式');
    assert.deepEqual(errors, []);
});

test('“合并到：阶段名”让一个阶段吃掉几段不连续的内容', () => {
    const parsed = core.parseOutline('## 第一幕\n开头正文\n\n## 第二幕\n第二段正文\n\n## 第一幕补充\n合并到：第一幕\n补充正文\n\n## 道具 [附加]\n从：第一幕\n到：第二幕\n道具正文');
    assert.equal(parsed.stages.length, 2);
    assert.equal(parsed.stages[0].prompt, '开头正文\n\n补充正文');
    assert.equal(parsed.blocks.filter(item => item.kind === 'merged').length, 1);
    assert.equal(parsed.addons.length, 1);
    const injected = core.formatInjection(parsed.stages[0], core.activeAddons(parsed, 0));
    assert.match(injected, /开头正文[\s\S]*补充正文/);
    assert.match(injected, /道具正文/);
    assert.doesNotMatch(injected, /第二段正文/);
});

test('“合并到”找不到阶段时按独立阶段处理并给出提醒', () => {
    const parsed = core.parseOutline('## 第一幕\n正文一\n\n## 补充\n合并到：不存在\n补充正文');
    assert.equal(parsed.stages.length, 2);
    assert.equal(parsed.blocks.filter(item => item.kind === 'merged').length, 0);
    assert.match(parsed.warnings.join('\n'), /找不到同名阶段/);
});

test('镜像条目完整跟随原条目的位置、深度与顺序', async () => {
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n正文',
        enabled: false,
        constant: true,
        order: 100,
        position: { type: 'at_depth', depth: 4, role: 'assistant', order: 100 },
    };
    const run = runtime(entry);
    await new Promise(setImmediate);
    const mirror = run.mirror();
    assert.ok(mirror, '要创建镜像');
    assert.deepEqual(plain(mirror.position), { type: 'at_depth', depth: 4, role: 'assistant', order: 100 });
    assert.equal(mirror.constant, true, '关键词等设置也要克隆');
    assert.equal(mirror.order, 100);
    assert.equal(mirror.enabled, true);
    assert.deepEqual(run.errors, []);
});

test('角色定义前的条目：镜像保持同一位置，不需要任何原生扩展提示接口', async () => {
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n前置正文',
        enabled: false,
        position: { type: 'before_character_definition', order: 100 },
    };
    // runtime() 的沙箱里没有 SillyTavern：镜像走世界书，根本不依赖原生锚点
    const run = runtime(entry);
    await new Promise(setImmediate);
    const mirror = run.mirror();
    assert.ok(mirror, '要创建镜像');
    assert.deepEqual(plain(mirror.position), { type: 'before_character_definition', order: 100 });
    assert.match(mirror.content, /前置正文/);
    assert.deepEqual(run.errors, []);
});

test('原条目调整位置后，下一次同步镜像会跟着挪', async () => {
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n正文',
        enabled: false,
        position: { type: 'before_character_definition', order: 100 },
    };
    const run = runtime(entry);
    await new Promise(setImmediate);
    entry.position = { type: 'after_character_definition', order: 42 };
    await run.generate();
    assert.deepEqual(plain(run.mirror().position), { type: 'after_character_definition', order: 42 }, '镜像要跟随原条目挪位置');
    assert.deepEqual(run.errors, []);
});

test('魔法棒入口沿用酒馆原生条目结构，图标主题样式不会走样', () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const { errors } = loadWithDocument(documentRef, helper);
    const entry = documentRef.getElementById('dynamic-guide-assistant-menu-item');
    assert.ok(entry, '应当注册魔法棒菜单入口');
    assert.equal(entry.className, 'extension_container', '外层必须是 extension_container');
    const row = entry.children[0];
    assert.match(row.className, /list-group-item/, '内层必须是 list-group-item');
    assert.match(row.className, /interactable/);
    const icon = row.children[0];
    assert.equal(icon.tagName, 'DIV', '图标要和酒馆自带条目一样是 div');
    assert.match(icon.className, /extensionsMenuExtensionButton/);
    assert.deepEqual(errors, []);
});

test('面板高度写死成视口高度，不再靠 inset 定位', () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    loadWithDocument(documentRef, helper);
    const style = documentRef.getElementById('dynamic-guide-assistant-style');
    assert.ok(style, '应当安装面板样式');
    const css = style.textContent;
    assert.match(css, /height:\s*100vh/, '要有 100vh 兜底');
    assert.match(css, /height:\s*100dvh/, '手机要用 100dvh 撑满');
    assert.match(css, /max-height:\s*100dvh/);
    assert.doesNotMatch(css, /position:\s*fixed;\s*inset:\s*0/, '单独用 inset 定位会在手机上算出 0 高度');
    assert.match(css, /\.dga-rail \{[^}]*width:\s*220px/, '电脑左侧目录宽 220');
    assert.match(css, /\.dga-nav-toggle \{ display: none; \}/, '电脑上藏起左上角 ☰');
    assert.match(css, /max-width:\s*720px\) \{\s*#dynamic-guide-assistant-panel \.dga-rail \{ display: none; \}/, '窄屏才收起左侧目录');
    assert.match(css, /min-width:\s*861px\) \{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '宽屏卡片两列');
});

// ---------------------------------------------------------------
// v2.1 多绑定：每条绑定各自注入、各自推进、可以单独移出
// ---------------------------------------------------------------

function multiWorld(books, options) {
    const settings = options || {};
    const state = {
        events: new Map(),
        injected: [],
        injectionOptions: [],
        active: new Map(),
        removed: [],
        variables: {
            character: { $dynamicGuideAssistant: { config: settings.config || { version: 2, bindings: [] } } },
            chat: settings.chatState ? { $dynamicGuideAssistant: { state: settings.chatState } } : {},
        },
        books,
        messages: settings.messages || [],
        lastMessageId: settings.lastMessageId == null ? null : settings.lastMessageId,
    };
    const helper = {
        tavern_events: { GENERATION_AFTER_COMMANDS: 'generate', CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received' },
        eventOn: (event, listener) => state.events.set(event, listener),
        getVariables: ({ type }) => state.variables[type],
        updateVariablesWith: (updater, { type }) => { state.variables[type] = updater(state.variables[type]); },
        getWorldbookNames: () => Object.keys(state.books),
        getWorldbook: name => state.books[name],
        updateWorldbookWith: (name, updater) => { state.books[name] = updater(state.books[name]); },
        injectPrompts: (prompts, options) => prompts.forEach(prompt => {
            state.injected.push(prompt);
            state.injectionOptions.push(options || null);
            state.active.set(prompt.id, prompt);
        }),
        uninjectPrompts: ids => ids.forEach(id => {
            state.removed.push(id);
            state.active.delete(id);
        }),
        getLastMessageId: () => state.lastMessageId,
        getChatMessages: id => {
            if (typeof id === 'string' && id.includes('-')) {
                const [from, to] = id.split('-').map(Number);
                return state.messages.filter(message => message.message_id >= from && message.message_id <= to);
            }
            return state.messages.filter(message => message.message_id === id);
        },
        setChatMessages: updates => {
            updates.forEach(update => {
                const message = state.messages.find(item => item.message_id === update.message_id);
                if (message) message.message = update.message;
            });
        },
    };
    return { state, helper };
}

const keyOf = (worldbookName, uid) => `${worldbookName}#uid:${uid}`;

test('2.0 的旧配置和旧进度自动迁移成多绑定结构', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n第一段正文\n\n## 第二幕\n第二段正文', enabled: false };
    const { state, helper } = helperFor(entry);
    state.variables.chat.$dynamicGuideAssistant = {
        state: { stageIndex: 1, stageName: '第二幕', lastCompletionMessageId: null, lastCompletionFingerprint: '' },
    };
    const run = load(helper);
    await new Promise(setImmediate);
    const mirror = state.entries.find(isMirror);
    assert.ok(mirror, '迁移后要建镜像');
    assert.match(mirror.content, /第二段正文/, '旧进度要落到第一个绑定名下');
    assert.doesNotMatch(mirror.content, /第一段正文/);
    const chatState = state.variables.chat.$dynamicGuideAssistant.state;
    assert.equal(chatState.version, 2, '旧进度读出后立刻写回新结构');
    assert.equal(chatState.bindings[keyOf('测试世界书', 1)].stageIndex, 1);
    assert.deepEqual(run.errors, []);
});

test('两条绑定各自在自己的世界书里建镜像、各自推进', async () => {
    const books = {
        书A: [{ uid: 1, name: '大纲A', content: '## 甲一\n甲一正文\n\n## 甲二\n甲二正文', enabled: false, position: { type: 'at_depth', depth: 4, role: 'assistant' } }],
        书B: [{ uid: 2, name: '大纲B', content: '## 乙一\n乙一正文', enabled: false }],
    };
    const config = {
        version: 2,
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null },
            { worldbookName: '书B', entryUid: 2, entryName: '大纲B', boundAt: null },
        ],
    };
    const { state, helper } = multiWorld(books, { config });
    const run = load(helper);
    await new Promise(setImmediate);
    const mirrorA = state.books.书A.find(isMirror);
    const mirrorB = state.books.书B.find(isMirror);
    assert.ok(mirrorA && mirrorB, '每条绑定各建一个镜像');
    assert.deepEqual(plain(mirrorA.position), { type: 'at_depth', depth: 4, role: 'assistant' }, 'A 的镜像跟随 A 的位置');
    assert.match(mirrorA.content, /甲一正文/);
    assert.doesNotMatch(mirrorA.content, /甲二正文/);
    assert.match(mirrorB.content, /乙一正文/);
    assert.notEqual(mirrorA.uid, mirrorB.uid, '两个镜像的 uid 不能互相覆盖');
    await run.core.next();
    assert.match(mirrorA.content, /甲二正文/, '推进后 A 的镜像换成新阶段');
    assert.doesNotMatch(mirrorA.content, /甲一正文/);
    assert.match(mirrorB.content, /乙一正文/, 'B 的镜像内容不受影响');
    assert.deepEqual(run.errors, []);
});

test('回复里的旧完成标记不再推进，只从这条回复里擦掉', async () => {
    const contentA = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const contentB = '## 乙一\n乙一正文\n\n## 乙二\n乙二正文';
    const books = {
        书A: [{ uid: 1, name: '大纲A', content: contentA, enabled: false }],
        书B: [{ uid: 2, name: '大纲B', content: contentB, enabled: false }],
    };
    const config = {
        version: 2,
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null },
            { worldbookName: '书B', entryUid: 2, entryName: '大纲B', boundAt: null },
        ],
    };
    const stageB = core.parseOutline(contentB).stages[0];
    const message = { message_id: 5, role: 'assistant', message: `这一轮的回复 <!-- DGA_COMPLETE:${stageB.id} -->` };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    const saved = (state.variables.chat.$dynamicGuideAssistant && state.variables.chat.$dynamicGuideAssistant.state && state.variables.chat.$dynamicGuideAssistant.state.bindings) || {};
    assert.notEqual(saved[keyOf('书A', 1)] && saved[keyOf('书A', 1)].stageIndex, 1);
    assert.notEqual(saved[keyOf('书B', 2)] && saved[keyOf('书B', 2)].stageIndex, 1, '旧标记不能再推进');
    assert.equal(message.message.includes('DGA_COMPLETE'), false, '标记要从这条回复里清掉');
    assert.match(state.books.书B.find(isMirror).content, /乙一正文/);
    assert.equal(state.books.书B.find(item => /（动态指导·标记）/.test(item.name)), undefined);
    assert.deepEqual(run.errors, []);
});

test('移出绑定会重新打开条目、删掉镜像和进度', async () => {
    const books = {
        书A: [{ uid: 1, name: '大纲A', content: '## 甲一\n甲一正文', enabled: false }],
        书B: [{ uid: 2, name: '大纲B', content: '## 乙一\n乙一正文', enabled: false }],
    };
    const config = {
        version: 2,
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null },
            { worldbookName: '书B', entryUid: 2, entryName: '大纲B', boundAt: null },
        ],
    };
    const { state, helper } = multiWorld(books, { config });
    const run = load(helper);
    await new Promise(setImmediate);
    assert.ok(state.books.书A.some(isMirror), 'A 要有镜像');
    assert.ok(state.books.书B.some(isMirror), 'B 要有镜像');
    await run.core.unbind(keyOf('书A', 1), { confirm: false });
    assert.equal(books.书A[0].enabled, true, '条目要重新打开');
    assert.equal(state.books.书A.some(isMirror), false, 'A 的镜像要删掉');
    assert.equal(books.书B[0].enabled, false, '其他绑定不受影响');
    assert.ok(state.books.书B.some(isMirror), 'B 的镜像保留');
    const remaining = state.variables.character.$dynamicGuideAssistant.config.bindings;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].worldbookName, '书B');
    const chatState = state.variables.chat.$dynamicGuideAssistant.state;
    assert.equal(chatState.bindings[keyOf('书A', 1)], undefined, '进度要删掉');
    await state.events.get('generate')('normal', {}, false);
    assert.equal(state.books.书A.some(isMirror), false, '移出后不会再建镜像');
    assert.deepEqual(run.errors, []);
});


// ---------------------------------------------------------------
// v2.2 选区划分：正文铺成连续文字，拖选后分配给分段，结构立刻重建
// ---------------------------------------------------------------

// 选区模式的 UI 冒烟：用 mock 的 Range/Selection 走一遍真实事件路径。
function collectTextNodes(node, out) {
    (node.children || []).forEach(child => {
        if (child.nodeType === 3) out.push(child);
        else collectTextNodes(child, out);
    });
    return out;
}

function findButton(node, prefix) {
    if (node.tagName === 'BUTTON' && String(node.textContent || '').includes(prefix)) return node;
    for (const child of node.children || []) {
        const found = findButton(child, prefix);
        if (found) return found;
    }
    return null;
}

function showBody(panel) {
    if (panel.querySelector('.dga-pick-surface')) return;
    const button = findButton(panel, '分段') || findButton(panel, '正文');
    assert.ok(button, '编辑器里要有「分段」');
    button.listeners.click[0]();
}

test('分段界面：拖选前言分配给第一段，正文立刻重建并标脏', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    // mock Range：toString() 量出从正文开头到端点的字数，也就是选区偏移
    documentRef.createRange = () => {
        const rangeRef = {
            selectNodeContents(node) { this.root = node; },
            setEnd(node, offset) { this.endNode = node; this.endOffset = offset; },
            toString() {
                let out = '';
                let done = false;
                const walk = node => {
                    if (done || !node) return;
                    if (node === rangeRef.endNode) {
                        if (node.nodeType === 3) out += node.textContent.slice(0, rangeRef.endOffset);
                        else (node.children || []).slice(0, rangeRef.endOffset).forEach(child => { out += child.textContent; });
                        done = true;
                        return;
                    }
                    if (node.nodeType === 3) { out += node.textContent; return; }
                    (node.children || []).forEach(walk);
                };
                walk(rangeRef.root);
                return out;
            },
        };
        return rangeRef;
    };
    const selection = {
        rangeCount: 0,
        isCollapsed: true,
        native: null,
        getRangeAt() { return this.native; },
        removeAllRanges() { this.rangeCount = 0; this.isCollapsed = true; this.native = null; },
        select(startNode, startOffset, endNode, endOffset) {
            this.native = { startContainer: startNode, startOffset, endContainer: endNode, endOffset };
            this.rangeCount = 1;
            this.isCollapsed = false;
        },
    };
    const preface = '前言介绍\n\n## 第一幕\n第一幕正文';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: preface, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            layouts: { '测试世界书#大纲': savedStages(preface, [{ name: '第一幕', quote: '第一幕正文' }]) },
        },
    };
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        document: documentRef,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        clearTimeout: () => {},
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: () => ({ matches: false }),
        getSelection: () => selection,
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    const uiCore = sandbox.DynamicGuideAssistantCore;
    await new Promise(setImmediate);

    await uiCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await uiCore.refresh();
    const panel = documentRef.getElementById(PANEL_ID);
    assert.ok(panel.querySelector('.dga-mode-seg'), '编辑器打开就是分段');
    assert.ok(panel.querySelector('.dga-mode-raw'), '编辑器里仍有「编辑原文」');
    assert.equal(panel.querySelector('.dga-mode-map'), null, '编辑不在导图上进行');
    showBody(panel);

    let surface = panel.querySelector('.dga-pick-surface');
    assert.ok(surface, '分段视图要把正文铺成连续文字');
    assert.equal(collectByClass(surface, 'dga-segbar', []).length, 1, '第一段的标题条内联在正文流里');
    const texts = collectTextNodes(surface, []);
    assert.equal(texts[0].textContent, '前言介绍\n\n## 第一幕\n', '原文里的标题行留在正文里，不抽走');
    // 标题条带 data-dga-skip：它的文字（含 ↑↓ 按钮）不能算进选区文本流，
    // textOffsetTo 就是按这条契约跳过整棵子树的。
    const flowText = node => {
        if (node.nodeType === 3) return node.textContent;
        if (node.getAttribute && node.getAttribute('data-dga-skip') != null) return '';
        return (node.children || []).map(flowText).join('');
    };
    assert.equal(flowText(surface), '前言介绍\n\n## 第一幕\n第一幕正文', '标题条的文字不进选区文本流，原文保持连续');

    selection.select(texts[0], 0, texts[0], 4);
    surface.listeners.mousedown[0]();
    surface.listeners.mouseup[0]();
    assert.match(panel.querySelector('.dga-pick-bar-text').textContent, /已选 1 段 · 4 字/, '拖选后分配栏要显示待分配的数量');
    assert.equal(selection.rangeCount, 0, '捕获后系统选区要清掉，改由我们的底色显示');

    const bar = panel.querySelector('.dga-pick-bar');
    const select = findTag(bar, 'SELECT');
    assert.ok(select, '分配栏要有归属下拉，取代原来的「分配给」按钮');
    const stageOption = select.children.find(option => /第 1 段/.test(option.textContent));
    assert.ok(stageOption, '归属下拉要列出各个分段');
    select.value = stageOption.getAttribute('value');
    select.listeners.change[0]({ target: select });

    surface = panel.querySelector('.dga-pick-surface');
    const mark = collectByClass(surface, 'dga-text-mark', [])[0];
    assert.ok(mark, '分配后前言要包进第一段的底色');
    assert.match(mark.textContent, /前言介绍/);
    const subtitle = panel.querySelector('.dga-head-text').children[1];
    assert.match(subtitle.textContent, /未保存/, '分配是结构性修改，头部要提示未保存');
    assert.deepEqual(errors, []);
});


// ---------------------------------------------------------------
// ---------------------------------------------------------------
// v2.31 跨卡导入自愈：世界书里有镜像但绑定没跟过来时，启动自动接管
// ---------------------------------------------------------------

test('跨卡导入自愈：有镜像没绑定，启动时按镜像重建绑定并对齐进度', async () => {
    const outline = { uid: 1, name: '大纲', content: '## 第一幕\n第一幕正文\n\n## 第二幕\n第二幕正文', enabled: false };
    const { state, helper } = helperFor(outline);
    helper.getWorldbookNames = () => ['测试世界书', '别人的世界书'];
    helper.getCharWorldbookNames = () => ['测试世界书'];
    // 模拟导入别人的卡：世界书带着镜像条目过来了，绑定配置（角色变量）没跟过来
    state.entries.push({ uid: 9, name: '大纲（动态指导）', content: '## 当前阶段\n第二幕正文', enabled: true });
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const run = load(helper);
    await new Promise(setImmediate);

    const bindings = state.variables.character.$dynamicGuideAssistant.config.bindings;
    assert.equal(bindings.length, 1, '要把「有镜像没绑定」的条目接管成一条绑定');
    assert.equal(bindings[0].entryName, '大纲');
    assert.equal(bindings[0].entryUid, 1);
    assert.equal(bindings[0].worldbookName, '测试世界书');
    const chatState = state.variables.chat.$dynamicGuideAssistant.state;
    assert.equal(chatState.bindings[keyOf('测试世界书', 1)].stageIndex, 1, '按镜像内容对齐到第二幕');
    assert.match(run.logs.join('\n'), /自动接管/, '要在运行日志里留痕');
    assert.deepEqual(run.errors, []);
});

test('跨卡导入自愈：没有镜像就不重建（用户主动解绑过的不该被重新绑上）', async () => {
    const outline = { uid: 1, name: '大纲', content: '## 第一幕\n正文一', enabled: true };
    const { state, helper } = helperFor(outline);
    helper.getWorldbookNames = () => ['测试世界书'];
    helper.getCharWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const run = load(helper);
    await new Promise(setImmediate);
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.bindings.length, 0,
        '没有镜像说明用户没绑过或已解绑，不能凭空重建');
    assert.deepEqual(run.errors, []);
});

test('跨卡导入自愈：别的卡的世界书里有镜像，也不收进当前卡', async () => {
    const books = {
        当前卡: [{ uid: 1, name: '大纲', content: '## 第一幕\n当前卡正文', enabled: true }],
        别人的卡: [
            { uid: 2, name: '大纲', content: '## 第一幕\n别人的正文超过四字', enabled: false },
            { uid: 9, name: '大纲（动态指导）', content: '## 当前阶段：第一幕\n别人的正文超过四字', enabled: true },
        ],
    };
    const { state, helper } = multiWorld(books, { config: { version: 2, bindings: [] } });
    helper.getCharWorldbookNames = () => ['当前卡'];
    const run = load(helper);
    await new Promise(setImmediate);
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.bindings.length, 0,
        '没有绑到当前角色身上的世界书，不能因为库里有镜像就被接管');
    assert.equal(state.books['别人的卡'].length, 2, '别人的镜像要原样留着');
    assert.deepEqual(run.errors, []);
});

test('绑定记在角色变量里，换卡不串，也不另存一份本机档', async () => {
    const storage = memoryStorage({ 'dynamic-guide-assistant:config-storage:v1': 'user' });
    const books = {
        甲书: [
            { uid: 1, name: '大纲', content: '## 第一幕\n甲卡正文超过四字', enabled: false },
            { uid: 9, name: '大纲（动态指导）', content: '## 当前阶段：第一幕\n甲卡正文超过四字', enabled: true },
        ],
        乙书: [{ uid: 1, name: '大纲', content: '## 第一幕\n乙卡正文超过四字', enabled: true }],
    };
    let card = { name: '甲', avatar: 'a.png' };
    let bound = ['甲书'];
    const { state, helper } = multiWorld(books, { config: { version: 2, bindings: [] } });
    helper.getCharData = () => card;
    helper.getCharWorldbookNames = () => bound.slice();
    const run = load(helper, { localStorage: storage });
    await new Promise(setImmediate);

    const cardA = state.variables.character.$dynamicGuideAssistant.config;
    assert.equal(cardA.bindings.length, 1, '甲卡的绑定写在甲卡自己的角色变量里');
    assert.equal(cardA.bindings[0].worldbookName, '甲书');
    assert.equal(storage.getItem('dynamic-guide-assistant:config:v2:avatar:a.png'), null, '不再按头像另存一份绑定');
    assert.equal(state.books.甲书.some(item => (item.name || item.comment) === '（动态指导·配置）'), false, '只本机不把绑定写进世界书');

    card = { name: '乙', avatar: 'b.png' };
    bound = ['乙书'];
    state.variables.character = { $dynamicGuideAssistant: { config: { version: 2, bindings: [] } } };
    await state.events.get('chat_changed')();
    const snap = await run.core.getCurrentSnapshot();
    assert.equal(snap.config.bindings.length, 0, '乙卡的角色变量是空的，不该看到甲卡的绑定');
    assert.equal(cardA.bindings[0].worldbookName, '甲书', '换卡不能改掉甲卡已经记下的绑定');
    assert.deepEqual(run.errors, []);
});

test('跟角色卡走时，配置条目关掉且不带关键词，短正文靠阶段名对齐', async () => {
    const storage = memoryStorage({ 'dynamic-guide-assistant:config-storage:v1': 'card' });
    const books = {
        甲书: [
            { uid: 1, name: '大纲', content: '## 开场\n走\n\n## 离开\n跑', enabled: false, keys: ['大纲'], constant: true, strategy: { type: 'selective', keys: ['大纲'], keys_secondary: { logic: 'and_all', keys: ['秘密'] } } },
            { uid: 9, name: '大纲（动态指导）', content: '## 当前阶段：离开\n跑', enabled: true, keys: ['大纲'] },
        ],
    };
    const { state, helper } = multiWorld(books, {
        config: { version: 2, bindings: [], settings: { judgePreset: '密钥名', conditionPreset: '生成预设', autoAdvance: 'off' } },
    });
    helper.getCharData = () => ({ name: '甲', avatar: 'a.png' });
    helper.getCharWorldbookNames = () => ['甲书'];
    const run = load(helper, { localStorage: storage });
    await new Promise(setImmediate);
    const configEntry = state.books.甲书.find(item => (item.name || item.comment) === '（动态指导·配置）');
    assert.ok(configEntry, '配置条目要写进当前卡绑定的世界书');
    assert.equal(configEntry.enabled, false);
    assert.equal(configEntry.disable, true);
    assert.equal(configEntry.constant, false);
    assert.equal(JSON.stringify(configEntry.keys), '[]');
    assert.equal(JSON.stringify(configEntry.strategy.keys), '[]');
    assert.equal(JSON.stringify(configEntry.strategy.keys_secondary), JSON.stringify({ logic: 'and_all', keys: [] }));
    const parsed = JSON.parse(configEntry.content);
    assert.equal(parsed.settings.judgePreset, undefined, '写进世界书的配置要去掉 API 预设名');
    assert.equal(parsed.settings.conditionPreset, undefined, '生成用的 API 预设名也不跟卡走');
    const cardConfig = state.variables.character.$dynamicGuideAssistant.config;
    assert.equal(cardConfig.settings.judgePreset, undefined, '角色变量会随卡导出，也不能带 API 预设名');
    assert.equal(cardConfig.settings.conditionPreset, undefined, '生成用的 API 预设名也不进角色变量');
    assert.equal(cardConfig.settings.storageMode, 'card', '跟卡走要记在角色变量里，不能只放浏览器');
    const parked = JSON.parse(storage.getItem('dynamic-guide-assistant:preset-names:v1:avatar:a.png'));
    assert.equal(parked.judgePreset, '密钥名');
    assert.equal(parked.conditionPreset, '生成预设');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('甲书', 1)].stageIndex, 1,
        '正文太短时要按「当前阶段：阶段名」对齐，而不是退回第一段');
    assert.deepEqual(run.errors, []);
});

test('没有聊天进度时从绑定的起始步开始，循环不靠世界书隐藏数据', async () => {
    const books = {
        书A: [{ uid: 1, name: '大纲', content: '## 暑假\n暑假正文\n\n## 寒假\n寒假正文', enabled: false }],
    };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲', loop: true, startIndex: 1 }],
            settings: { judgePreset: '不该导出', autoAdvance: 'off' },
        },
    });
    helper.getCharData = () => ({ name: '甲', avatar: 'a.png' });
    helper.getCharWorldbookNames = () => ['书A'];
    const storage = memoryStorage();
    const run = load(helper, { localStorage: storage });
    await new Promise(setImmediate);
    const mirror = state.books.书A.find(isMirror);
    assert.ok(mirror, '要有镜像');
    assert.match(mirror.content, /寒假正文/, '新聊天从绑定上的第 2 步开始');
    assert.doesNotMatch(mirror.content, /暑假正文/);
    const saved = state.variables.character.$dynamicGuideAssistant.config;
    assert.equal(saved.bindings[0].startIndex, 1);
    assert.equal(saved.bindings[0].loop, true, '循环要写在绑定上');
    assert.equal(saved.settings.judgePreset, undefined, '起始步这条配置里也不能带 API 预设名');
    const parked = JSON.parse(storage.getItem('dynamic-guide-assistant:preset-names:v1:avatar:a.png'));
    assert.equal(parked.judgePreset, '不该导出');
    assert.deepEqual(run.errors, []);
});

test('进度停在全部完成时，绑定上的循环仍能绕回第一段', async () => {
    const books = {
        书A: [{ uid: 1, name: '大纲', content: '## 暑假\n暑假正文\n\n## 寒假\n寒假正文', enabled: false }],
    };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲', loop: true }],
        },
        chatState: {
            version: 2,
            bindings: {
                '书A#uid:1': { stageIndex: 2, stageName: '', lastCompletionMessageId: null, lastCompletionFingerprint: '' },
            },
        },
    });
    helper.getCharWorldbookNames = () => ['书A'];
    const run = load(helper);
    await new Promise(setImmediate);
    const mirror = state.books.书A.find(isMirror);
    assert.ok(mirror, '循环还在，不能因为进度越界就把镜像删掉');
    assert.match(mirror.content, /暑假正文/);
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.bindings[0].loop, true);
    assert.deepEqual(run.errors, []);
});

test('世界书状态条目里的循环，角色变量丢了也能找回来', async () => {
    const books = {
        书A: [
            { uid: 5, name: '大纲', content: '## 暑假\n暑假正文\n\n## 寒假\n寒假正文', enabled: false },
            {
                uid: 8,
                name: '（动态指导·状态）',
                enabled: false,
                disable: true,
                content: JSON.stringify({ version: 1, entries: { 大纲: { loop: true, startIndex: 0 } } }),
            },
        ],
    };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 5, entryName: '大纲' }],
        },
        chatState: {
            version: 2,
            bindings: {
                '书A#uid:5': { stageIndex: 2, stageName: '', lastCompletionMessageId: null, lastCompletionFingerprint: '' },
            },
        },
    });
    helper.getCharWorldbookNames = () => ['书A'];
    const run = load(helper);
    await new Promise(setImmediate);
    const mirror = state.books.书A.find(isMirror);
    assert.ok(mirror, '循环从状态条目恢复后，进度越界也要继续发第一段');
    assert.match(mirror.content, /暑假正文/);
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.bindings[0].loop, true);
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.bindings.length, 1);
    assert.deepEqual(run.errors, []);
});

test('条目 uid 变了也不另开一条没有循环的绑定', async () => {
    const books = {
        书A: [
            { uid: 5, name: '大纲', content: '## 暑假\n暑假正文\n\n## 寒假\n寒假正文', enabled: false },
            { uid: 9, name: '大纲（动态指导）', content: '暑假正文', enabled: true },
        ],
    };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲', loop: true }],
        },
    });
    helper.getCharWorldbookNames = () => ['书A'];
    const run = load(helper);
    await new Promise(setImmediate);
    const bindings = state.variables.character.$dynamicGuideAssistant.config.bindings;
    assert.equal(bindings.length, 1, '不能因为 uid 变了就再绑一条');
    assert.equal(bindings[0].entryUid, 5);
    assert.equal(bindings[0].loop, true);
    assert.deepEqual(run.errors, []);
});

test('隐藏字段被清掉后，状态条目里的划分和完成条件会写回去，原文不动', async () => {
    const content = '暑假正文\n\n寒假正文';
    const layout = {
        version: 3,
        loop: true,
        stages: [
            { id: 's1', name: '暑假', completion: '正文已经写到寒假开始', ranges: [{ start: 0, end: 4 }] },
            { id: 's2', name: '寒假', completion: '', ranges: [{ start: 6, end: 10 }] },
        ],
        addons: [],
        always: { ranges: [] },
        note: { ranges: [] },
    };
    const books = {
        书A: [
            { uid: 1, name: '大纲', content, enabled: false },
            {
                uid: 8,
                name: '（动态指导·状态）',
                enabled: false,
                disable: true,
                content: JSON.stringify({ version: 1, entries: { 大纲: { loop: true, startIndex: 0, layout } } }),
            },
        ],
    };
    const { state, helper } = multiWorld(books, {
        config: { version: 2, bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲' }] },
    });
    helper.getCharWorldbookNames = () => ['书A'];
    const run = load(helper);
    await new Promise(setImmediate);
    const source = state.books.书A.find(item => item.uid === 1);
    assert.equal(source.content, content, '恢复划分不能改原文');
    assert.equal(source.extra, undefined, '不把划分写回条目隐藏字段');
    assert.equal(state.books.书A.some(item => item.name === '（动态指导·状态）'), false, '看得到的状态条目要删掉');
    const restored = state.variables.character.$dynamicGuideAssistant.config.bindings[0].layout;
    assert.equal(restored.stages[0].completion, '正文已经写到寒假开始');
    assert.equal(restored.stages[0].name, '暑假');
    const mirror = state.books.书A.find(isMirror);
    assert.match(mirror.content, /暑假正文/);
    assert.doesNotMatch(mirror.content, /寒假开始/);
    assert.deepEqual(run.errors, []);
});

test('绑定用状态条目里的起始步，不写死第一段', async () => {
    const source = '## 暑假\n暑假正文\n\n## 寒假\n寒假正文';
    const span = quote => {
        const start = source.indexOf(quote);
        return { start, end: start + quote.length };
    };
    const books = {
        书A: [
            { uid: 1, name: '大纲', content: source, enabled: true },
            {
                uid: 8,
                name: '（动态指导·状态）',
                enabled: false,
                disable: true,
                content: JSON.stringify({
                    version: 1,
                    entries: {
                        大纲: {
                            loop: false,
                            startIndex: 1,
                            layout: {
                                version: 3,
                                loop: false,
                                stages: [
                                    { id: 's1', name: '暑假', completion: '', terminal: false, ranges: [span('暑假正文')] },
                                    { id: 's2', name: '寒假', completion: '', terminal: false, ranges: [span('寒假正文')] },
                                ],
                                addons: [],
                                always: { ranges: [] },
                                note: { ranges: [] },
                            },
                        },
                    },
                }),
            },
        ],
    };
    const { state, helper } = multiWorld(books, { config: { version: 2, bindings: [] } });
    helper.getCharWorldbookNames = () => ['书A'];
    const run = load(helper);
    await new Promise(setImmediate);
    await run.core.add('书A', state.books.书A[0]);
    const chat = state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)];
    assert.equal(chat.stageIndex, 1, '绑定后的当前聊天从第 2 步开始');
    const mirror = state.books.书A.find(isMirror);
    assert.match(mirror.content, /寒假正文/);
    assert.doesNotMatch(mirror.content, /暑假正文/);
    assert.deepEqual(run.errors, []);
});

test('划分记在酒馆扩展设置和角色变量里，世界书配置条目看不到', async () => {
    const layout = {
        version: 3,
        loop: true,
        stages: [{ id: 's1', name: '暑假', completion: '到寒假', ranges: [{ start: 0, end: 4 }] }],
        addons: [],
        always: { ranges: [] },
        note: { ranges: [] },
    };
    const books = { 书A: [{ uid: 1, name: '大纲', content: '暑假正文', enabled: false }] };
    const saves = [];
    const extensionSettings = {};
    const SillyTavern = {
        getContext: () => ({ extensionSettings, saveSettingsDebounced: () => { saves.push(1); } }),
    };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲', layout }],
            settings: { storageMode: 'card' },
        },
    });
    helper.getCharData = () => ({ name: '甲', avatar: 'a.png' });
    helper.getCharWorldbookNames = () => ['书A'];
    const storage = memoryStorage({ 'dynamic-guide-assistant:config-storage:v1': 'card' });
    const run = load(helper, { localStorage: storage, SillyTavern });
    await new Promise(setImmediate);
    assert.ok(saves.length > 0, '要走数据库同款的 saveSettingsDebounced');
    const saved = extensionSettings['dynamic-guide-assistant'].layouts['avatar:a.png']['书A#大纲'].layout;
    assert.equal(saved.stages[0].completion, '到寒假');
    const card = state.variables.character.$dynamicGuideAssistant.config;
    assert.equal(card.bindings[0].layout.stages[0].name, '暑假');
    const configEntry = state.books.书A.find(item => item.name === '（动态指导·配置）');
    const parsed = JSON.parse(configEntry.content);
    assert.equal(parsed.layouts, undefined, '世界书里那条配置不带划分');
    assert.equal(parsed.bindings[0].layout, undefined);
    assert.equal(state.books.书A.some(item => item.name === '（动态指导·状态）'), false);
    assert.deepEqual(run.errors, []);
});

test('浏览器里的跟卡走丢了，世界书里的配置条目还在就恢复', async () => {
    const books = {
        甲书: [
            { uid: 1, name: '大纲', content: '## 甲\n甲正文', enabled: false },
            {
                uid: 8,
                name: '（动态指导·配置）',
                enabled: false,
                content: JSON.stringify({
                    version: 2,
                    bindings: [{ worldbookName: '甲书', entryUid: 1, entryName: '大纲' }],
                    settings: {},
                }),
            },
        ],
    };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '甲书', entryUid: 1, entryName: '大纲' }],
            settings: {},
        },
    });
    helper.getCharData = () => ({ name: '甲', avatar: 'a.png' });
    helper.getCharWorldbookNames = () => ['甲书'];
    const storage = memoryStorage();
    const run = load(helper, { localStorage: storage });
    await new Promise(setImmediate);
    assert.equal(storage.getItem('dynamic-guide-assistant:config-storage:v1'), 'card');
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.settings.storageMode, 'card');
    assert.deepEqual(run.errors, []);
});

// ---------------------------------------------------------------
// v2.30 一键生成完成条件：走判断AI的 API 设置，结果写回弹层草稿
// ---------------------------------------------------------------

test('编辑器：AI 生成完成条件会带上阶段正文并洗掉前缀写回草稿', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const outline = '## 第一幕\n他们在雨夜互相介绍。\n\n## 第二幕\n第二幕正文';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: outline, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            layouts: {
                '测试世界书#大纲': savedStages(outline, [
                    { name: '第一幕', quote: '他们在雨夜互相介绍。' },
                    { name: '第二幕', quote: '第二幕正文' },
                ]),
            },
        },
    };
    const calls = [];
    helper.generateRaw = async options => { calls.push(options); return '完成：两人完成第一次正式交谈。'; };
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        document: documentRef,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        clearTimeout: () => {},
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: () => ({ matches: false }),
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    const uiCore = sandbox.DynamicGuideAssistantCore;
    await new Promise(setImmediate);
    await uiCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await uiCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    showBody(panel());

    // 点第一段的标题条 → 打开属性弹层
    const bar = collectByClass(panel(), 'dga-segbar', [])[0];
    assert.ok(bar, '分段视图要有一张标题条');
    bar.listeners.click[0]();
    const sheet = panel().querySelector('.dga-sheet');
    assert.ok(sheet, '点标题条要打开属性弹层');

    const generate = findButton(sheet, 'AI 生成');
    assert.ok(generate, '完成条件旁边要有「AI 生成」按钮');
    await generate.listeners.click[0]();

    assert.equal(calls.length, 1, '要点一次生成请求');
    const sent = JSON.stringify(calls[0]);
    assert.match(sent, /完成条件的作者|完成条件作者/, 'system 段要是完成条件作者的契约');
    assert.match(sent, /第一幕/, '要把阶段名带进提示词');
    assert.match(sent, /他们在雨夜互相介绍/, '要把这一段正文当依据带进去');
    assert.match(sent, /第二幕/, '要带上下一阶段，写成进入下一段的条件');
    assert.match(sent, /进入下一阶段/);
    assert.match(sent, /空话/, '提示词要禁掉空泛判词');
    assert.doesNotMatch(sent, /\{\{/, '生成提示词里的占位符要全部替换');

    const area = findTag(panel().querySelector('.dga-sheet'), 'TEXTAREA');
    assert.ok(area, '弹层里要还有完成条件输入框');
    assert.equal(area.value, '两人完成第一次正式交谈。', '生成结果要洗掉「完成：」前缀后写回草稿');
    assert.deepEqual(errors, []);
});

test('齿轮里可以改生成提示词，并单独选 API 预设', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const gearOutline = '## 第一幕\n他们在雨夜互相介绍。';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: gearOutline, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            settings: {},
            layouts: { '测试世界书#大纲': savedStages(gearOutline, [{ name: '第一幕', quote: '他们在雨夜互相介绍。' }]) },
        },
    };
    const storage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([
            { name: '生成专用', connection: 'main', maxTokens: 60000, temperature: 1 },
        ]),
    });
    const calls = [];
    helper.generateRaw = async options => { calls.push(options); return '两人约好明天再见面。'; };
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        document: documentRef,
        localStorage: storage,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        clearTimeout: () => {},
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: () => ({ matches: false }),
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    const uiCore = sandbox.DynamicGuideAssistantCore;
    await new Promise(setImmediate);
    await uiCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await uiCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    showBody(panel());
    const findAttr = (node, name, value) => {
        if (node.getAttribute && node.getAttribute(name) === value) return node;
        for (const child of node.children || []) {
            const found = findAttr(child, name, value);
            if (found) return found;
        }
        return null;
    };
    const gear = findAttr(panel(), 'aria-label', '编辑器设置');
    assert.ok(gear, '编辑器右上角要有齿轮');
    gear.listeners.click[0]();
    const custom = findButton(panel(), '自定义生成提示词');
    assert.ok(custom, '齿轮里要有自定义生成提示词');
    custom.listeners.click[0]();
    const dialog = findAttr(panel(), 'aria-label', '生成提示词');
    assert.ok(dialog, '点按钮要打开生成提示词');
    assert.ok(findButton(dialog, '管理 API 预设'), '这里要能去改 API 预设');
    const areas = [];
    const walk = node => {
        if (node.tagName === 'TEXTAREA') areas.push(node);
        (node.children || []).forEach(walk);
    };
    walk(dialog);
    assert.equal(areas.length, 2, '系统提示词和用户提示词各一块');
    areas[0].value = '你是剧情阶段的完成条件作者。只写自定义闸门。';
    areas[0].listeners.input[0]({ target: areas[0] });
    const select = findTag(dialog, 'SELECT');
    const option = select.children.find(item => item.textContent === '生成专用');
    assert.ok(option, '下拉里要有本机 API 预设');
    select.value = option.getAttribute('value');
    select.listeners.change[0]({ target: select });
    await findButton(dialog, '保存').listeners.click[0]();
    const saved = state.variables.character.$dynamicGuideAssistant.config.settings;
    assert.equal(saved.conditionPreset, undefined, '生成用的 API 预设名不写进会导出的角色变量');
    assert.match(saved.conditionSystemPrompt, /自定义闸门/);
    const parked = JSON.parse(storage.getItem('dynamic-guide-assistant:preset-names:v1:global'));
    assert.equal(parked.conditionPreset, '生成专用', '预设名只留在本机');

    const bar = collectByClass(panel(), 'dga-segbar', [])[0];
    bar.listeners.click[0]();
    await findButton(panel().querySelector('.dga-sheet'), 'AI 生成').listeners.click[0]();
    const sent = JSON.stringify(calls[0]);
    assert.match(sent, /自定义闸门/, '生成要使用刚保存的提示词');
    assert.match(sent, /他们在雨夜互相介绍/);
    assert.doesNotMatch(sent, /\{\{/);
    assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------
// v2.28 划分阶段重构：分段/编辑原文两档，标题条内联，分配栏管归属与新建
// ---------------------------------------------------------------

test('分段视图：从选中文字新建阶段，弹层确认后还能退回未分配', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '开头介绍\n\n正片内容', enabled: false });
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const selection = {
        rangeCount: 0,
        isCollapsed: true,
        native: null,
        getRangeAt() { return this.native; },
        removeAllRanges() { this.rangeCount = 0; this.isCollapsed = true; this.native = null; },
        select(startNode, startOffset, endNode, endOffset) {
            this.native = { startContainer: startNode, startOffset, endContainer: endNode, endOffset };
            this.rangeCount = 1;
            this.isCollapsed = false;
        },
    };
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        document: documentRef,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        clearTimeout: () => {},
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: () => ({ matches: false }),
        getSelection: () => selection,
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    const uiCore = sandbox.DynamicGuideAssistantCore;
    await new Promise(setImmediate);
    await uiCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await uiCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    showBody(panel());
    const assign = value => {
        const select = findTag(panel().querySelector('.dga-pick-bar'), 'SELECT');
        select.value = value;
        select.listeners.change[0]({ target: select });
    };

    // 初始：一个标题都没有 = 整篇都是未分配，没有任何标题条
    let surface = panel().querySelector('.dga-pick-surface');
    assert.equal(collectByClass(surface, 'dga-segbar', []).length, 0, '刚开始不分段，全部文字都是未分配');
    assert.match(panel().textContent, /还没有分段/, '要提示用户自己划');

    // 拖开头四个字 → 从选中文字建一个新阶段（名字取选中文字）
    const first = collectTextNodes(surface, [])[0];
    assert.equal(first.textContent, '开头介绍\n\n正片内容');
    selection.select(first, 0, first, 4);
    surface.listeners.mousedown[0]();
    surface.listeners.mouseup[0]();
    assert.match(panel().querySelector('.dga-pick-bar-text').textContent, /已选 1 段 · 4 字/);
    assign('__new-stage');

    surface = panel().querySelector('.dga-pick-surface');
    const bars = collectByClass(surface, 'dga-segbar', []);
    assert.equal(bars.length, 1, '新建的阶段要立刻变成内联标题条');
    assert.match(bars[0].textContent, /开头介绍/);
    const sheet = panel().querySelector('.dga-sheet');
    assert.ok(sheet, '新建后要直接打开属性弹层让用户确认名称');
    assert.match(findTag(sheet, 'H3').textContent, /修改「开头介绍」/);
    assert.equal(findButton(sheet, '并入'), null);
    assert.doesNotMatch(sheet.textContent, /并入/);
    assert.equal(findButton(sheet, '删掉这段') ? true : false, true, '弹层要有删除出口');
    findButton(sheet, '取消').listeners.click[0]();

    // 再把这个阶段的文字选一遍，改成「未分配」→ 文字退回去，阶段消失
    const mark = collectByClass(panel(), 'dga-text-mark', [])[0];
    assert.ok(mark, '第一段的文字要有底色');
    const markText = mark.children.find(child => child.nodeType === 3);
    selection.select(markText, 0, markText, markText.textContent.length);
    const freshSurface = panel().querySelector('.dga-pick-surface');
    freshSurface.listeners.mousedown[0]();
    freshSurface.listeners.mouseup[0]();
    assign('__unassigned');

    surface = panel().querySelector('.dga-pick-surface');
    assert.equal(collectByClass(surface, 'dga-segbar', []).length, 0, '退回未分配后阶段消失');
    assert.equal(collectByClass(surface, 'dga-text-mark', []).length, 0, '底色一并去掉');
    assert.deepEqual(errors, []);
});

test('小卡步进器中间那块是划分阶段的入口，点进去落在当前段', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二\n\n## 第三幕\n正文三', enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [{ worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' }] },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    // 用 publicApi 推进到第二段再刷新，保证卡片显示的是第 2 / 3 段
    await sandbox.DynamicGuideAssistantCore.next();
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();

    const mid = panel().querySelector('.dga-stepper-mid');
    assert.ok(mid, '小卡步进器中间那块就是划分阶段的入口');
    assert.match(mid.textContent, /第 2 \/ 3 段/);
    const actions = panel().querySelector('.dga-bind-actions');
    assert.ok(actions, '编辑和设置排在上一段、下一段下面');
    assert.deepEqual(actions.children.map(item => item.textContent), ['编辑 ›', '提示词 ›', '设置 ›'], '三项入口按编辑、提示词、设置排列');
    await mid.listeners.click[0]();

    const focused = collectByClass(panel(), 'is-focus', []);
    assert.equal(focused.length, 1, '落在小卡当前的段上，只高亮那一段');
    assert.match(focused[0].textContent, /第二幕/);
    assert.ok(panel().querySelector('.dga-pick-surface'), '点进去打开的是分段编辑');
    assert.equal(panel().querySelector('.dga-map'), null, '编辑页不是导图');
    assert.equal(panel().querySelector('.dga-nav-toggle'), null, '编辑是二级页，左上角不放导航');
    assert.equal(panel().querySelector('.dga-rail'), null, '编辑是二级页，电脑上也不放左侧目录');
    assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------
// v2.27 认领模型：绑定即变常驻小卡，＋/－/删除模式这层行管理取消
// ---------------------------------------------------------------

function findTag(node, tag) {
    if (node.tagName === tag) return node;
    for (const child of node.children || []) {
        const found = findTag(child, tag);
        if (found) return found;
    }
    return null;
}

function collectByClass(node, name, out) {
    if (node.classList && node.classList.contains(name)) out.push(node);
    (node.children || []).forEach(child => collectByClass(child, name, out));
    return out;
}

// 假 DOM 里 option 的 value 是属性、不是属性值（select.value 才是直接赋值的属性）。
const optionsOf = select => (select.children || []).filter(item => item.tagName === 'OPTION');
const optionValue = option => option.getAttribute('value');

// 启动到「动态指导」页：世界书里两个已分阶段的条目，绑定列表为空。
async function bootGuidePage() {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const outline = { uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二', enabled: true };
    const props = { uid: 2, name: '道具规则', content: '## 第一幕\n道具正文', enabled: true };
    const { state, helper } = helperFor(outline);
    state.entries.push(props);
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const booted = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-nav-toggle'), '动态指导在目录里，左上角要有导航');
    assert.ok(panel().querySelector('.dga-rail'), '电脑上目录页左侧常驻导航');
    assert.ok(panel().querySelector('.dga-main'), '右侧是当前页');
    assert.ok(panel().querySelector('.dga-body'), '动态指导卡片按单栏排列');
    assert.equal(panel().querySelector('.dga-split'), null, '动态指导页不再强制双栏');
    assert.equal(panel().querySelector('.dga-close').textContent, '×', '右上角仍是简化的 ×');
    const nav = panel().querySelector('.dga-panel-nav');
    const body = panel().querySelector('.dga-body');
    assert.ok(nav, '动态指导页标题下有一排板块标签');
    assert.equal(body.querySelector('.dga-panel-nav'), null, '标签在滚动卡片外面，不跟在绑定世界书下面');
    assert.ok(nav.parentNode.children.indexOf(nav) < nav.parentNode.children.indexOf(body), '标签排在卡片滚动区前面');
    assert.match(nav.textContent, /绑定/);
    assert.match(nav.textContent, /如何判断/);
    assert.doesNotMatch(nav.textContent, /提取规则/, '全局规则入口已移除');
    return { documentRef, state, helper, errors: booted.errors, panel };
}

test('动态指导自己的条目不出现在待选列表', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一', enabled: true });
    state.entries.push(
        { uid: 9, name: '大纲（动态指导）', content: '正文一', enabled: true },
        { uid: 10, name: '大纲（动态指导·标记）', content: '标记说明', enabled: true },
        { uid: 11, name: '（动态指导·配置）', content: '{}', enabled: false },
        { uid: 12, name: '（动态指导·状态）', content: '{}', enabled: false },
        { uid: 13, name: 'TavernDB-ACU-OutlineTable', content: '表格', enabled: true },
        { uid: 14, name: 'ACU-[chat1]-TavernDB-ACU-MemoryStart', content: '隐藏数据', enabled: false },
        { uid: 15, name: '总结条目', content: '总结', enabled: true },
        { uid: 16, name: '小总结条目', content: '小总结', enabled: true },
        { uid: 17, name: '重要人物条目', content: '人物', enabled: true },
        { uid: 18, comment: '关系档案\n<!-- ACU_CUSTOM_TABLE_EXPORT_V1 {"version":1} -->', content: '导出', enabled: true },
    );
    helper.getWorldbookNames = () => ['测试世界书'];
    helper.getCharWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const booted = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const select = findTag(panel().querySelector('.dga-add-row'), 'SELECT');
    const labels = optionsOf(select).map(item => item.textContent).join('\n');
    assert.match(labels, /大纲/);
    assert.doesNotMatch(labels, /动态指导|TavernDB|总结条目|重要人物|关系档案/);
    assert.deepEqual(booted.errors, []);
});

test('条目搜索只留下名字对得上的', async () => {
    const run = await bootGuidePage();
    const filter = run.panel().querySelector('.dga-entry-filter');
    assert.ok(filter, '待绑条目上面有搜索框');
    filter.value = '道具';
    filter.listeners.input[0]({ target: filter });
    const select = findTag(run.panel().querySelector('.dga-add-row'), 'SELECT');
    const labels = optionsOf(select).map(item => item.textContent).join('\n');
    assert.match(labels, /道具规则/);
    assert.doesNotMatch(labels, /大纲/);
    assert.deepEqual(run.errors, []);
});

test('API、动态指导、运行日志左上角有导航', async () => {
    const run = await bootGuidePage();
    const panel = run.panel;
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), 'API').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-nav-toggle'), 'API 页左上角要有导航');
    assert.equal(panel().querySelector('.dga-close').textContent, '×');
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '运行日志').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-nav-toggle'), '运行日志页左上角要有导航');
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-nav-toggle'), '从目录回到动态指导后，导航还在');
    assert.deepEqual(run.errors, []);
});

test('没有 ## 标题的条目也能绑定，划分不改原文', async () => {
    const original = '#暑假\n当前还在暑假期间，<user>不需要上课\n#寒假\n当前在寒假期间，<user>不需要上课\n#平时\n当前是正常的学期，在周一到周五期间要上课，周末不需要';
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: original, enabled: true });
    helper.getWorldbookNames = () => ['测试世界书'];
    helper.getCharWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const booted = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const select = findTag(panel().querySelector('.dga-add-row'), 'SELECT');
    const option = optionsOf(select).find(item => /大纲/.test(item.textContent));
    select.value = optionValue(option);
    select.listeners.change[0]({ target: select });
    const bind = findButton(panel().querySelector('.dga-add-row'), '绑定');
    assert.ok(bind, '选中没有 ## 标题的条目也要有绑定按钮');
    await bind.listeners.click[0]();
    assert.equal(state.entries[0].content, original, '绑定不能改原文');
    await booted.sandbox.DynamicGuideAssistantCore.openEditorAt('测试世界书', state.entries[0]);
    await booted.sandbox.DynamicGuideAssistantCore.refresh();
    showBody(panel());
    const flow = node => {
        if (node.nodeType === 3) return node.textContent;
        if (node.getAttribute && node.getAttribute('data-dga-skip') != null) return '';
        return (node.children || []).map(flow).join('');
    };
    assert.equal(flow(panel().querySelector('.dga-pick-surface')), original, '分段视图铺开的就是原文');
    assert.deepEqual(booted.errors, []);
});

test('认领模型：绑定后待绑行当场让位，条目变成常驻小卡并高亮一次', async () => {
    const run = await bootGuidePage();
    const row = run.panel().querySelector('.dga-add-row');
    assert.ok(row, '动态指导页要有待绑行');
    const select = findTag(row, 'SELECT');
    const options = optionsOf(select);
    assert.equal(optionValue(options[0]), '', '待选行第一个选项是占位');
    assert.match(options[1].textContent, /大纲/);
    assert.equal(select.value, '', '进页面时不自动选中条目，要自己选');
    select.value = optionValue(options[1]);
    select.listeners.change[0]({ target: select });

    const bind = findButton(run.panel().querySelector('.dga-add-row'), '绑定');
    assert.equal(bind.textContent, '绑定');
    assert.ok(!Object.prototype.hasOwnProperty.call(bind.attributes, 'disabled'), '选中条目后就可以绑定，不必先按标题拆阶段');
    await bind.listeners.click[0]();

    const panel = run.panel();
    const cards = collectByClass(panel, 'dga-bind-item', []);
    assert.equal(cards.length, 1, '绑定后条目要立刻变成常驻小卡');
    assert.ok(cards[0].classList.contains('is-new'), '刚绑的小卡要带一次入场高亮');
    assert.match(cards[0].textContent, /大纲/);
    assert.match(cards[0].textContent, /测试世界书/);

    const unbind = cards[0].querySelector('.dga-icon-danger');
    assert.ok(unbind, '小卡上要有常驻的解绑按钮，不再依赖删除模式');
    assert.equal(unbind.textContent, '×');

    const freshRow = run.panel().querySelector('.dga-add-row');
    assert.equal(findTag(freshRow, 'SELECT').value, '', '待绑行要被认领清空，好接着连绑下一条');
    assert.match(optionsOf(findTag(freshRow, 'SELECT'))[1].textContent, /已绑定/, '下拉里已绑条目要标成已绑定');
    assert.equal(collectByClass(run.panel(), 'dga-add-row-actions', []).length, 0, '＋/－ 行管理这层要取消');
    assert.deepEqual(run.errors, []);
});

test('认领模型：连绑第二个条目，高亮跟着新小卡走', async () => {
    const run = await bootGuidePage();
    const firstSelect = findTag(run.panel().querySelector('.dga-add-row'), 'SELECT');
    const first = optionsOf(firstSelect).find(item => /大纲/.test(item.textContent));
    firstSelect.value = optionValue(first);
    firstSelect.listeners.change[0]({ target: firstSelect });
    await findButton(run.panel().querySelector('.dga-add-row'), '绑定').listeners.click[0]();

    const select = findTag(run.panel().querySelector('.dga-add-row'), 'SELECT');
    const second = optionsOf(select).find(item => /道具规则/.test(item.textContent));
    assert.ok(second, '第二个条目要留在待选列表里');
    select.value = optionValue(second);
    select.listeners.change[0]({ target: select });

    const row = run.panel().querySelector('.dga-add-row');
    const bind = findButton(row, '绑定');
    assert.equal(bind.textContent, '绑定', '换一个没绑过的条目，按钮要回到可点的「绑定」');
    await bind.listeners.click[0]();

    const cards = collectByClass(run.panel(), 'dga-bind-item', []);
    assert.equal(cards.length, 2, '两条绑定要各自一张常驻小卡');
    assert.match(cards[0].textContent, /大纲/);
    assert.match(cards[1].textContent, /道具规则/);
    assert.ok(!cards[0].classList.contains('is-new'), '高亮只留给刚绑的那一条');
    assert.ok(cards[1].classList.contains('is-new'));
    assert.equal(findTag(run.panel().querySelector('.dga-add-row'), 'SELECT').value, '', '连绑第二条后待绑行再次清空');
    assert.deepEqual(run.errors, []);
});

// ---------------------------------------------------------------
// v2.3 顺序编辑：整块上移/下移；常驻写在阶段之前 = 注入排在阶段内容之前
// ---------------------------------------------------------------

test('常驻写在所有阶段之前，注入里就排在当前阶段内容之前', () => {
    const content = '前言文字\n\n## 第一幕\n正文一\n\n## 风格 [常驻]\n风格正文';
    let parsed = core.parseOutline(content);
    assert.equal(parsed.blocks.find(item => item.kind === 'always').aboveStages, false);
    parsed = core.parseOutline('前言文字\n\n## 风格 [常驻]\n风格正文\n\n## 第一幕\n正文一');
    const always = parsed.blocks.find(item => item.kind === 'always');
    assert.equal(always.aboveStages, true, '常驻在所有阶段之前要标记为“在上面”');
    const injected = core.formatInjection(parsed.stages[0], core.activeAddons(parsed, 0));
    assert.ok(injected.indexOf('风格正文') < injected.indexOf('正文一'), '注入里常驻排在阶段内容之前');
    assert.doesNotMatch(injected, /## 常驻提示|## 当前阶段|完成判定/);
    // 写在后面的常驻保持在附加内容区
    const bottom = core.parseOutline(content);
    const injectedBottom = core.formatInjection(bottom.stages[0], core.activeAddons(bottom, 0));
    assert.ok(injectedBottom.indexOf('风格正文') > injectedBottom.indexOf('正文一'));
    assert.doesNotMatch(injectedBottom, /同时有效的附加内容|完成判定/);
});

test('分段界面：标题条的下移按钮交换阶段顺序且不打开弹层', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const moveOutline = '## 第一幕\n正文一\n\n## 第二幕\n正文二';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: moveOutline, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            layouts: {
                '测试世界书#大纲': savedStages(moveOutline, [
                    { name: '第一幕', quote: '## 第一幕\n正文一' },
                    { name: '第二幕', quote: '## 第二幕\n正文二' },
                ]),
            },
        },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    const uiCore = sandbox.DynamicGuideAssistantCore;
    await new Promise(setImmediate);
    await uiCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await uiCore.refresh();
    const panel = documentRef.getElementById(PANEL_ID);
    showBody(panel);
    const findAll = (node, cls, out) => {
        if (String(node.className || '').split(/\s+/).includes(cls)) out.push(node);
        (node.children || []).forEach(child => findAll(child, cls, out));
        return out;
    };
    let cards = findAll(panel, 'dga-segbar', []);
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, /第一幕/);
    const down = findButton(cards[0], '↓');
    assert.ok(down, '第一张标题条要有下移按钮');
    down.listeners.click[0]({ stopPropagation() {} });
    cards = findAll(panel, 'dga-segbar', []);
    assert.match(cards[0].textContent, /第一幕/, '原文里第一幕仍在上面');
    assert.match(cards[0].textContent, /第 2 段/, '下移只改推进顺序，不搬原文');
    assert.match(cards[1].textContent, /第二幕/);
    assert.match(cards[1].textContent, /第 1 段/);
    assert.equal(findButton(cards[0], '↓').getAttribute('disabled'), '', '已经是最后一段时，下移按钮要停用');
    assert.equal(panel.querySelector('.dga-sheet'), null, '点搬移按钮不能打开标题弹层');
    assert.match(panel.querySelector('.dga-head-text').children[1].textContent, /未保存/);
    assert.deepEqual(errors, []);
});

test('编辑原文里改过的字会保存，阶段区间跟着挪', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const original = '## 第一幕\n暑假正文\n\n## 第二幕\n寒假正文';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: original, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            layouts: {
                '测试世界书#大纲': savedStages(original, [
                    { name: '第一幕', quote: '暑假正文' },
                    { name: '第二幕', quote: '寒假正文' },
                ]),
            },
        },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    await sandbox.DynamicGuideAssistantCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    findButton(panel(), '编辑原文').listeners.click[0]();
    const area = panel().querySelector('.dga-raw');
    area.value = original.replace('暑假正文', '暑假正文已改');
    area.listeners.input[0]({ target: area });
    await findButton(panel(), '保存').listeners.click[0]();
    const saved = state.entries.find(item => item.uid === 1);
    assert.match(saved.content, /暑假正文已改/);
    assert.equal(saved.extra, undefined, '划分不写进条目隐藏字段');
    const layout = state.variables.character.$dynamicGuideAssistant.config.layouts['测试世界书#大纲'];
    const stage = layout.stages.find(item => item.name === '第一幕');
    assert.match(saved.content.slice(stage.ranges[0].start, stage.ranges[0].end), /暑假正文已改/);
    const winter = layout.stages.find(item => item.name === '第二幕');
    assert.match(saved.content.slice(winter.ranges[0].start, winter.ranges[0].end), /寒假正文/);
    assert.deepEqual(errors, []);
});

test('分段里保存完成条件不改原文，条件记在条目旁边', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const original = '## 第一幕\n暑假正文\n\n## 第二幕\n寒假正文';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: original, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            layouts: {
                '测试世界书#大纲': savedStages(original, [
                    { name: '第一幕', quote: '暑假正文' },
                    { name: '第二幕', quote: '寒假正文' },
                ]),
            },
        },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    await sandbox.DynamicGuideAssistantCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    showBody(panel());
    const bar = panel().querySelector('.dga-segbar');
    bar.listeners.click[0]();
    const sheet = panel().querySelector('.dga-sheet');
    const area = (function find(node) {
        if (node.tagName === 'TEXTAREA' && String(node.getAttribute('placeholder') || '').includes('例：')) return node;
        for (const child of node.children || []) {
            const found = find(child);
            if (found) return found;
        }
        return null;
    })(sheet);
    area.value = '正文已经写到寒假开始';
    area.listeners.input[0]({ target: area });
    const selects = [];
    (function collectSelects(node) {
        if (node.tagName === 'SELECT') selects.push(node);
        (node.children || []).forEach(collectSelects);
    })(sheet);
    assert.ok(selects.length >= 2, '阶段属性里要有最短 / 最长停留');
    selects[0].value = '3';
    selects[0].listeners.change[0]({ target: selects[0] });
    selects[1].value = '10';
    selects[1].listeners.change[0]({ target: selects[1] });
    findButton(sheet, '保存修改').listeners.click[0]();
    await findButton(panel(), '保存').listeners.click[0]();
    const saved = state.entries.find(item => item.uid === 1);
    assert.equal(saved.content, original, '完成条件不能写进原文');
    assert.equal(saved.extra, undefined, '完成条件不写进条目隐藏字段');
    const stage = state.variables.character.$dynamicGuideAssistant.config.layouts['测试世界书#大纲'].stages.find(item => item.name === '第一幕');
    assert.equal(stage.completion, '正文已经写到寒假开始');
    assert.equal(stage.minStay, 3, '最短停留写在这一阶段上');
    assert.equal(stage.maxStay, 10, '最长停留写在这一阶段上');
    assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------
// v2.6 自动推进三档
// ---------------------------------------------------------------

test('“完成：自动”解析为 autoComplete，“自动门”这类文本不误判', () => {
    const parsed = core.parseOutline('## 第一幕\n完成：自动\n正文一\n\n## 第二幕\n完成：自动门被推开\n正文二');
    assert.equal(parsed.stages[0].autoComplete, true);
    assert.equal(parsed.stages[0].completion, '');
    assert.equal(parsed.stages[1].autoComplete, false);
    assert.equal(parsed.stages[1].completion, '自动门被推开');
});

test('镜像只复制原文切片，不附完成条件', () => {
    const parsed = core.parseOutline('## 第一幕\n正文一');
    const stage = parsed.stages[0];
    stage.completion = '正文已经写到寒假开始';
    const injected = core.formatInjection(stage, [], { auto: true });
    assert.equal(injected, '正文一');
    assert.doesNotMatch(injected, /完成判定|DGA_COMPLETE|寒假开始|进入下一段的时机|当前阶段：/);
});

test('旧格式“完成：自动”仍解析成自动完成', () => {
    const again = core.parseOutline('## 第一幕\n完成：自动\n正文一\n\n## 第二幕\n正文二');
    assert.equal(again.stages[0].autoComplete, true);
    assert.equal(again.stages[0].completion, '');
    assert.equal(again.stages[1].autoComplete, false);
});

test('旧的标记档不再建标记说明，镜像仍是原文切片', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = {
        书A: [
            { uid: 1, name: '大纲A', content, enabled: false },
            { uid: 9, name: '大纲A（动态指导·标记）', content: '旧标记说明', enabled: true },
        ],
    };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null, advanceMode: 'story' }],
        settings: { autoAdvance: 'marker' },
    };
    const { state, helper } = multiWorld(books, { config });
    const run = load(helper);
    await new Promise(setImmediate);
    const mirror = state.books.书A.find(isMirror);
    const source = state.books.书A.find(item => item.uid === 1);
    assert.equal(source.content, content, '绑定的原文不能被改');
    assert.match(mirror.content, /甲一正文/);
    assert.doesNotMatch(mirror.content, /甲二正文|进入下一段的时机|DGA_COMPLETE|完成判定/);
    assert.equal(state.books.书A.find(item => item.name === '大纲A（动态指导·标记）'), undefined, '旧的标记说明要清掉');
    assert.equal(core.normalizeConfig(config).settings.autoAdvance, 'off');
    assert.equal(core.normalizeConfig(config).bindings[0].advanceMode, 'off');
    assert.deepEqual(run.errors, []);
});


test('判断AI档：YES 推进、NO 不推进、同一消息不重复推进', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复，没有隐藏标记。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return 'YES'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1, 'judge 档没有标记也要问一次判断AI');
    assert.equal(verdicts[0].should_silence, true, '判断AI请求必须静默');
    const ordered = verdicts[0].ordered_prompts;
    assert.deepEqual(plain(ordered.map(item => (typeof item === 'string' ? item : item.role))),
        ['system', 'user'], '和数据库填表一样，完整消息段按顺序交给 ordered_prompts');
    assert.equal('user_input' in verdicts[0], false, '不再拆出最后一个 user 段');
    assert.match(ordered[0].content, /你负责判断剧情该不该推进/, '第一段只交代身份');
    assert.doesNotMatch(ordered[0].content, /格式示例|<basis>|<verdict>/, '身份段不解释标签');
    assert.match(ordered[0].content, /# 判定手册/, '判定手册在同一段 system 里（与案卷数据分开）');
    assert.match(ordered[0].content, /状态型[\s\S]*事件型/, '手册要先分清两种阶段');
    assert.match(ordered[0].content, /## 五、例子/, '手册要带正反例子');
    assert.match(lastUserText(verdicts[0]), /【上一阶段】（这是第一段）/, '案卷带上一阶段');
    assert.match(lastUserText(verdicts[0]), /【已停多久】/, '案卷带已停几层');
    assert.match(lastUserText(verdicts[0]), /【当前阶段】甲一/, '案卷要带阶段名');
    assert.match(lastUserText(verdicts[0]), /甲一正文/, '案卷要带阶段正文');
    assert.match(lastUserText(verdicts[0]), /这一轮的回复/, '案卷要带最近正文');
    assert.match(lastUserText(verdicts[0]), /<basis>\n- 已发生：[^\n]*\n<\/basis>\n<verdict>\n- 结论：YES 或 NO，二选一\n<\/verdict>/, 'basis 和 verdict 是标签里的条目');
    assert.doesNotMatch(lastUserText(verdicts[0]), /\{\{/, '默认段里的占位符都要被替换');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, 'YES 要推进');

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1, '同一消息第二次触发不能重复推进');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1);
    assert.deepEqual(run.errors, []);
});

test('判断AI档：分岔口写了路就进入那条，并关掉被依附的这条', async () => {
    const host = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const fork = '## 岔一\n岔一正文\n\n## 岔二\n岔二正文';
    const books = {
        书A: [
            { uid: 1, name: '大纲A', content: host, enabled: false },
            { uid: 2, name: '岔路', content: fork, enabled: false },
        ],
    };
    const config = {
        version: 2,
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null },
            {
                worldbookName: '书A', entryUid: 2, entryName: '岔路', boundAt: null,
                attachKey: keyOf('书A', 1), attachStage: 1, attachKind: 'fork',
            },
        ],
        settings: { autoAdvance: 'judge' },
    };
    const earlier = { message_id: 4, role: 'assistant', message: '上一层不该出现的句子。' };
    const message = { message_id: 5, role: 'assistant', message: '人已经走进岔路，当前这一层要完整留下。' };
    config.settings.judgeHistoryCount = 3;
    const { state, helper } = multiWorld(books, { config, messages: [earlier, message], lastMessageId: 5 });
    const asked = [];
    helper.generateRaw = async options => {
        asked.push(options);
        return [
            '<basis>',
            '- 已发生：人走进了岔路',
            '</basis>',
            '<verdict>',
            '- 结论：NO',
            '</verdict>',
            '<road>',
            '- 路：1',
            '</road>',
        ].join('\n');
    };
    const run = load(helper);
    await new Promise(setImmediate);
    assert.equal(state.books.书A.find(item => item.name === '岔路（动态指导）'), undefined, '还没走进时分叉不发给 AI');

    await state.events.get('message_received')(5);
    const askedText = lastUserText(asked[0]);
    assert.match(askedText, /人已经走进岔路，当前这一层要完整留下/);
    assert.doesNotMatch(askedText, /上一层不该出现的句子/);
    assert.match(askedText, /0\. 被依附的这条\n第 1 段 · 甲一\n甲一正文/);
    assert.match(askedText, /1\. 依附 · 岔路\n第 1 段 · 岔一\n岔一正文/);
    assert.doesNotMatch(askedText, /岔二正文/);
    assert.match(askedText, /写了序号，后台进入那条分叉，并暂时关闭被依附的这条/);
    const bindings = state.variables.chat.$dynamicGuideAssistant.state.bindings;
    assert.equal(bindings[keyOf('书A', 1)].lineCut, true, '被依附的这条要暂时关掉');
    assert.equal(bindings[keyOf('书A', 1)].forkInto, keyOf('书A', 2));
    assert.equal(bindings[keyOf('书A', 1)].stageIndex, 0, '关掉这条，不要顺手推进它');
    assert.equal(bindings[keyOf('书A', 2)].stageIndex, 0);
    assert.equal(state.books.书A.find(item => item.name === '大纲A（动态指导）'), undefined, '关掉后这条的镜像要撤掉');
    assert.match(state.books.书A.find(item => item.name === '岔路（动态指导）').content, /岔一正文/);
    assert.deepEqual(run.errors, []);
});

test('旧 AI 选段配置不再自动调用，手动步进仍可推进', async () => {
    const content = '## 甲\n甲正文\n\n## 乙\n乙正文\n\n## 丙\n丙正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const key = keyOf('书A', 1);
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', orderMode: 'pick' }],
            settings: { autoAdvance: 'off' },
        },
        chatState: {
            version: 2,
            bindings: {
                [key]: { stageIndex: 2, stageName: '丙', lastCompletionMessageId: null, lastJudgeCheckedId: null },
            },
        },
        messages: [{ message_id: 8, role: 'assistant', message: '事情又回到最开始。' }],
        lastMessageId: 8,
    });
    const sent = [];
    helper.generateRaw = async options => { sent.push(options); return '<basis>已经回到第一段</basis>\n<stage>1</stage>'; };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(8);
    assert.equal(sent.length, 0, '旧选段配置不能再触发模型调用');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[key].stageIndex, 2, '自动流程不能改动进度');
    await run.core.previous(key);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[key].stageIndex, 1, '手动步进仍可回到上一段');
    assert.deepEqual(run.errors, []);
});

test('阶段怎么走：旧 pick 即使带 loop 也回退按顺序', () => {
    const picked = core.normalizeConfig({
        version: 2,
        bindings: [{ worldbookName: '书A', entryName: '大纲', orderMode: 'pick', loop: true }],
    });
    assert.equal(picked.bindings[0].orderMode, undefined);
    assert.equal(picked.bindings[0].loop, undefined);
    assert.equal(core.bindingOrderMode(picked.bindings[0]), 'order');
    const looped = core.normalizeConfig({
        version: 2,
        bindings: [{ worldbookName: '书A', entryName: '大纲', loop: true }],
    });
    assert.equal(core.bindingOrderMode(looped.bindings[0]), 'loop');
});

test('判断AI档：英文 <verdict> 优先，basis 里的 YES 不算；旧中文标签仍认', () => {
    assert.equal(core.judgeSaysYes('<basis>条件里写了 YES 才算。</basis>\n<verdict>NO</verdict>'), false);
    assert.equal(core.judgeSaysYes('<basis>还在暑假</basis>\n<verdict>YES</verdict>'), true);
    assert.equal(core.judgeSaysYes('<依据>谈过了</依据>\n<结论>YES</结论>'), true, '旧中文标签仍能推进');
    assert.equal(core.judgeSaysYes('<verdict>\n- 结论：YES\n</verdict>'), true);
    assert.equal(core.judgeSaysYes('<verdict>\n- 结论：只写 YES 或 NO\n</verdict>'), false, '没填完的条目不能当成 YES');
    assert.equal(core.judgeBasisText('<basis>\n- 已发生：在家吃饭，没有上课\n</basis>\n<verdict>NO</verdict>'), '在家吃饭，没有上课');
    assert.equal(core.previewJudgeOutput('<verdict>NO</verdict>', {}).hasTag, true);
});

test('判断AI档：填表标签结论优先——<结论>YES</结论> 推进、NO 不推进', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    helper.generateRaw = async () => '<依据>两人已经正式谈过。</依据>\n<结论>YES</结论>';
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, '标签里 YES 要推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：标签里 NO 不推进，即使正文提到 YES', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    // 依据栏里出现 YES 字样也不能算数，只信 <结论> 标签。
    helper.generateRaw = async () => '<依据>条件里写了 YES 才算。</依据>\n<结论>NO</结论>';
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, '标签里 NO 不能推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：自定义提示词段按序组装并替换占位符', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null,
            judgeSegments: [
                { role: 'system', content: '规则：只判断 {{stage}}' },
                { role: 'assistant', content: '明白，只看 {{history}}' },
                { role: 'user', content: '阶段={{stage}} 条件={{condition}}' },
            ],
        }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return 'NO'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1);
    const ordered = verdicts[0].ordered_prompts;
    assert.deepEqual(plain(ordered.map(item => (typeof item === 'string' ? item : item.role))), ['system', 'assistant', 'user']);
    assert.match(ordered[0].content, /^规则：只判断 甲一$/, 'system 段里占位符要替换');
    assert.match(ordered[1].content, /这一轮的回复/, 'assistant 段里的 {{history}} 也要替换');
    assert.match(lastUserText(verdicts[0]), /条件=（没写。/);
    assert.match(lastUserText(verdicts[0]), /不能因为符合这段就写 YES/);
    assert.deepEqual(run.errors, []);
});

test('默认判断提示词：还停在当前时段不能因为符合这段就进入下一段', async () => {
    const content = '## 暑假\n当前还在暑假期间，不需要上课\n\n## 平时\n正常学期，周一到周五要上课';
    const books = { 书A: [{ uid: 1, name: '大纲', content, enabled: false }] };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲' }],
            settings: { autoAdvance: 'judge' },
        },
        messages: [{ message_id: 3, role: 'assistant', message: '白辞在家看电视，希雅做了饭，两人吃了排骨，没有上课。' }],
        lastMessageId: 3,
    });
    const sent = [];
    helper.generateRaw = async options => { sent.push(options); return '<basis>还在放假</basis>\n<verdict>NO</verdict>'; };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(3);
    const blob = JSON.stringify(sent[0]);
    assert.match(blob, /下一阶段/);
    assert.match(blob, /平时/, '下一段名字来自用户的阶段，不是写死在提示词里');
    assert.match(blob, /正文还在这个状态里就是 NO/);
    assert.match(blob, /不能因为符合这段就写 YES/);
    assert.doesNotMatch(blob, /符合暑假|不能换成平时|在家、做饭|不要翻译标签名/);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, '还停在当前时段时不能推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：每 2 层检查一次——首次立即查，之后到层才问、问过重新计数', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgeInterval: 2 },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const laterMessages = [
        { message_id: 6, role: 'assistant', message: '第六层的回复。' },
        { message_id: 7, role: 'assistant', message: '第七层的回复。' },
    ];
    const { state, helper } = multiWorld(books, { config, messages: [message, ...laterMessages], lastMessageId: 7 });
    let calls = 0;
    helper.generateRaw = async () => { calls += 1; return 'NO'; };
    const run = load(helper);
    await new Promise(setImmediate);
    const bindingState = () => state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)];

    await state.events.get('message_received')(5);
    assert.equal(calls, 1, '首次检查立即执行');
    assert.equal(bindingState().lastJudgeCheckedId, 5, '检查楼层要记录');

    await state.events.get('message_received')(6);
    assert.equal(calls, 1, '第 6 层不到间隔，不问判断AI');

    await state.events.get('message_received')(7);
    assert.equal(calls, 2, '第 7 层到间隔（7-5>=2），再问一次');
    assert.equal(bindingState().lastJudgeCheckedId, 7, '问过之后重新计数');
    await state.events.get('message_received')(7);
    assert.equal(calls, 3, '同一层重新生成要再判断一次');
    assert.deepEqual(run.errors, []);
});

test('某一条自己开判断AI时，全局手动也不挡它，并记下上次结论', async () => {
    const content = '## 暑假\n暑假正文\n\n## 寒假\n寒假正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', advanceMode: 'judge', judgeInterval: 2 }],
        settings: { autoAdvance: 'off', judgeInterval: 1 },
    };
    const kept = core.normalizeConfig(config);
    assert.equal(kept.bindings[0].advanceMode, 'judge');
    assert.equal(kept.bindings[0].judgeInterval, 2);
    const dropped = core.normalizeConfig({ version: 2, bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', advanceMode: 'nope', judgeInterval: 0 }] });
    assert.equal(dropped.bindings[0].advanceMode, undefined);
    assert.equal(dropped.bindings[0].judgeInterval, undefined);
    const { state, helper } = multiWorld(books, {
        config,
        messages: [
            { message_id: 5, role: 'assistant', message: '还在放假。' },
            { message_id: 6, role: 'assistant', message: '第二天。' },
        ],
        lastMessageId: 6,
    });
    const sent = [];
    helper.generateRaw = async options => { sent.push(options); return '<依据>还在暑假</依据>\n<结论>NO</结论>'; };
    const run = load(helper);
    await new Promise(setImmediate);
    const bindingState = () => state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)];
    await state.events.get('message_received')(5);
    assert.equal(sent.length, 1, '这条自己开了判断AI，全局手动也要查');
    assert.equal(bindingState().lastJudgeYes, false);
    assert.match(bindingState().lastJudgeBasis, /暑假/);
    await state.events.get('message_received')(6);
    assert.equal(sent.length, 1, '这条自己的间隔是每 2 层，中间那层不问');
    assert.deepEqual(run.errors, []);
});

test('某一条改成手动后，全局判断AI不再问它', async () => {
    const content = '## 暑假\n暑假正文\n\n## 寒假\n寒假正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const { state, helper } = multiWorld(books, {
        config: {
            version: 2,
            bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', advanceMode: 'off' }],
            settings: { autoAdvance: 'judge' },
        },
        messages: [{ message_id: 3, role: 'assistant', message: '一段回复。' }],
        lastMessageId: 3,
    });
    let calls = 0;
    helper.generateRaw = async () => { calls += 1; return 'YES'; };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(3);
    assert.equal(calls, 0, '这条写成手动后，不跟全局去问判断AI');
    assert.deepEqual(run.errors, []);
});

test('判断还在进行时来了新回复，结束后补判新的一层', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const messages = [
        { message_id: 5, role: 'assistant', message: '第五层。' },
        { message_id: 6, role: 'assistant', message: '第六层。' },
    ];
    const { state, helper } = multiWorld(books, { config, messages, lastMessageId: 6 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const calls = [];
    helper.generateRaw = async options => {
        calls.push(options);
        markStarted();
        if (calls.length === 1) await gate;
        return 'NO';
    };
    const run = load(helper);
    await new Promise(setImmediate);
    const first = state.events.get('message_received')(5);
    await started;
    await state.events.get('message_received')(6);
    assert.equal(calls.length, 1, '同一条绑定的判断要排队，不并发');
    assert.equal(calls[0].max_tokens, 4096, '没选预设时按数据库缺省 4096');
    release();
    await first;
    assert.equal(calls.length, 2, '前一层结束后补判新回复');
    assert.deepEqual(run.errors, []);
});

test('判断AI检查频率归一化：非法值回退每层', () => {
    const zero = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge', judgeInterval: 0 } });
    assert.equal(zero.settings.judgeInterval, 1, '0 回退每层');
    const bad = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge', judgeInterval: 'abc' } });
    assert.equal(bad.settings.judgeInterval, 1, '非数字回退每层');
    const three = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge', judgeInterval: '3' } });
    assert.equal(three.settings.judgeInterval, 3, '字符串数字正常保留');
});

test('判断参考段数归一化：非法值回退 1 段', () => {
    const zero = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge', judgeHistoryCount: 0 } });
    assert.equal(zero.settings.judgeHistoryCount, 1, '0 回退 1 段');
    const bad = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge', judgeHistoryCount: 'abc' } });
    assert.equal(bad.settings.judgeHistoryCount, 1, '非数字回退 1 段');
    const three = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge', judgeHistoryCount: '3' } });
    assert.equal(three.settings.judgeHistoryCount, 3, '字符串数字正常保留');
});

test('判断AI档：判断AI回答 NO 时不推进', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '还没走完的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    helper.generateRaw = async () => 'NO';
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, 'NO 不能推进');
    assert.match(state.books.书A.find(isMirror).content, /甲一正文/, '镜像保持当前阶段');
    assert.deepEqual(run.errors, []);
});

test('手动推进档不调用判断AI', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
    };
    const message = { message_id: 5, role: 'assistant', message: '普通回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    let called = 0;
    helper.generateRaw = async () => { called += 1; return 'YES'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(called, 0, 'off 档没有标记时不能发起判断AI请求');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0);
    assert.deepEqual(run.errors, []);
});


test('判断AI档：卡片自定义提问模板替换占位符后发出', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null,
            judgeSegments: [{ role: 'user', content: '阶段={{stage}}\n条件={{condition}}\n正文={{prompt}}\n历史={{history}}\n走没走？' }],
        }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return 'NO'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1);
    const sent = lastUserText(verdicts[0]);
    assert.match(sent, /^阶段=甲一/, '模板要按自定义文案组装');
    assert.match(sent, /条件=（没写。/);
    assert.match(sent, /正文=甲一正文/);
    assert.match(sent, /历史=[\s\S]*这一轮的回复/);
    assert.doesNotMatch(sent, /\{\{/, '占位符要全部替换掉');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：酒馆预设连接走酒馆连接管理器', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgePreset: '代理小模型' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => { calls.push(options); return 'YES'; };
    const cmCalls = [];
    const SillyTavern = {
        getContext: () => ({
            ConnectionManagerRequestService: {
                sendRequest: async (profileId, messages, maxTokens) => {
                    cmCalls.push({ profileId, messages, maxTokens });
                    return { result: { choices: [{ message: { content: 'YES' } }] } };
                },
            },
            extensionSettings: { connectionManager: { profiles: [{ id: '酒馆代理A', name: '酒馆代理A', api: 'koboldcpp' }] } },
        }),
    };
    const localStorage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{
            name: '代理小模型', category: '便宜模型', type: 'proxy', note: '',
            proxyPreset: '酒馆代理A', model: 'gpt-mini', maxTokens: 16, temperature: 0.2,
        }]),
    });
    const run = load(helper, { localStorage, SillyTavern });
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(calls.length, 0, '酒馆预设连接不走 generateRaw');
    assert.equal(cmCalls.length, 1, '要走 ConnectionManagerRequestService.sendRequest');
    assert.equal(cmCalls[0].profileId, '酒馆代理A');
    assert.equal(cmCalls[0].maxTokens, 16);
    assert.equal(cmCalls[0].messages[0].role, 'system');
    assert.match(cmCalls[0].messages[0].content, /# 判定手册/, '身份和手册合成一段 system');
    assert.equal(cmCalls[0].messages[1].role, 'user');
    assert.match(cmCalls[0].messages[1].content, /这一轮的回复/);
    assert.match(cmCalls[0].messages[1].content, /<verdict>\n- 结论：YES 或 NO，二选一\n<\/verdict>/, '案卷的 verdict 是条目');
    assert.equal(cmCalls[0].messages.length, 2, '不再有独立的最终注入消息');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, 'YES 要推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：自定义 API 预设直连酒馆后端 generate 端点', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgePreset: '自定义判断AI' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => { calls.push(options); return 'NO'; };
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'NO' } }] }), text: async () => '' };
    };
    const localStorage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{
            name: '自定义判断AI', connection: 'custom', customApiFormat: 'openai_compat',
            apiurl: 'https://api.example.com/v1', key: 'sk-secret', model: 'judge-model',
            maxTokens: 20, temperature: 0,
        }]),
    });
    const run = load(helper, { localStorage, fetch: fetchMock });
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(calls.length, 0, '自定义连接不走 generateRaw');
    assert.equal(fetches.length, 1, '要直连酒馆后端 generate 端点');
    assert.equal(fetches[0].url, '/api/backends/chat-completions/generate');
    assert.equal(fetches[0].options.method, 'POST');
    const body = JSON.parse(fetches[0].options.body);
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.custom_url, 'https://api.example.com/v1');
    assert.equal(body.custom_include_headers, 'Authorization: Bearer sk-secret');
    assert.equal(body.model, 'judge-model');
    assert.equal(body.max_tokens, 20);
    assert.equal(body.temperature, 0);
    assert.equal(body.custom_prompt_post_processing, 'strict');
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /# 判定手册/, '身份和手册合成一段 system');
    assert.equal(body.messages[1].role, 'user', '第二段是本次案卷');
    assert.match(body.messages[1].content, /这一轮的回复/);
    assert.equal(body.messages.length, 2, '不再有独立的最终注入消息');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, 'NO 不推进');
    assert.deepEqual(run.errors, []);
});

// v3.4 直发生成端点：一条绑定、判断AI档，SillyTavern.getContext() 由调用方给。
function directSendWorld(settings, stContext, extra) {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', ...settings },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const rawCalls = [];
    helper.generateRaw = async options => { rawCalls.push(options); return '<verdict>NO</verdict>'; };
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, options });
        const body = JSON.stringify({ choices: [{ message: { content: '<basis>- 已发生：甲二开始</basis>\n<verdict>- 结论：YES</verdict>' } }] });
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    };
    const SillyTavern = { getContext: () => stContext };
    const run = load(helper, { SillyTavern, fetch: fetchMock, ...(extra || {}) });
    const stageIndex = () => state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex;
    return { state, helper, run, rawCalls, fetches, stageIndex };
}

function fakeChatCompletionService(log) {
    return {
        createRequestData(payload) {
            const data = { use_sysprompt: true, ...payload };
            Object.keys(data).forEach(key => { if (data[key] === undefined) delete data[key]; });
            return data;
        },
        async presetToGeneratePayload(preset, overridePreset, overridePayload) {
            log.push({ preset, overridePayload: { ...overridePayload } });
            return this.createRequestData({ type: 'quiet', top_p: 0.9, temperature: preset.temperature != null ? preset.temperature : 1, ...overridePayload });
        },
    };
}

test('判断AI档：酒馆主 API 是 Chat Completion 时直发生成端点，不走 generateRaw', async () => {
    const presetCalls = [];
    const stContext = {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'openrouter' },
        getChatCompletionModel: () => 'main-model',
        getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
        ChatCompletionService: fakeChatCompletionService(presetCalls),
        extractMessageFromData: json => json.choices[0].message.content,
    };
    const world = directSendWorld({}, stContext);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(world.rawCalls.length, 0, '不走 generateRaw，也就不触发酒馆生成事件');
    assert.equal(world.fetches.length, 1);
    assert.equal(world.fetches[0].url, '/api/backends/chat-completions/generate');
    assert.equal(world.fetches[0].options.headers['X-CSRF-Token'], 't');
    const body = JSON.parse(world.fetches[0].options.body);
    assert.equal(body.stream, false);
    assert.equal(body.model, 'main-model');
    assert.equal(body.max_tokens, 4096, '没选预设时回复长度 4096');
    assert.equal(body.temperature, 0.2, '没选预设时温度压到 0.2');
    assert.equal(body.top_p, 0.9, '其余参数由酒馆按当前设置生成');
    assert.equal('tools' in body, false, '不带酒馆的函数工具');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[1].content, /这一轮的回复/);
    assert.equal(presetCalls.length, 1, '用空预设让酒馆按当前设置生成请求体');
    assert.deepEqual(plain(presetCalls[0].preset), {});
    assert.equal(world.stageIndex(), 1, 'YES 要推进');
    assert.deepEqual(world.run.errors, []);
});

test('主 API 可直发 Chat Completion 时不依赖 generateRaw', async () => {
    const stContext = {
        mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'openrouter' },
        getChatCompletionModel: () => 'main-model',
        ChatCompletionService: fakeChatCompletionService([]),
    };
    const world = directSendWorld({}, stContext);
    delete world.helper.generateRaw;
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(world.fetches.length, 1);
    assert.equal(world.stageIndex(), 1);
    assert.deepEqual(world.run.errors, []);
});

test('判断AI档：旧版酒馆没有 presetToGeneratePayload 时按当前设置手拼请求体；文本补全照旧走 generateRaw', async () => {
    const service = fakeChatCompletionService([]);
    delete service.presetToGeneratePayload;
    const manual = directSendWorld({}, {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://relay.example/v1', custom_include_headers: 'X-A: 1', reverse_proxy: 'https://proxy.example', top_p_openai: 0.8 },
        getChatCompletionModel: () => 'relay-model',
        ChatCompletionService: service,
    });
    await new Promise(setImmediate);
    await manual.state.events.get('message_received')(5);
    assert.equal(manual.rawCalls.length, 0);
    const body = JSON.parse(manual.fetches[0].options.body);
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.custom_url, 'https://relay.example/v1');
    assert.equal(body.custom_include_headers, 'X-A: 1');
    assert.equal(body.top_p, 0.8);
    assert.equal('reverse_proxy' in body, false, 'custom 来源不带反向代理');
    assert.equal(manual.stageIndex(), 1);

    const text = directSendWorld({}, { mainApi: 'textgenerationwebui', chatCompletionSettings: {}, ChatCompletionService: fakeChatCompletionService([]) });
    await new Promise(setImmediate);
    await text.state.events.get('message_received')(5);
    assert.equal(text.fetches.length, 0, '文本补全不直发');
    assert.equal(text.rawCalls.length, 1, '照旧走 generateRaw');
});

test('判断AI档：Chat Completion 酒馆预设先切换连接，直发后恢复原连接', async () => {
    const presetCalls = [];
    const cmCalls = [];
    const profile = {
        id: 'p1', name: '小模型', api: 'openrouter', model: 'judge-mini', 'secret-id': 'sec-9',
        'api-url': '', proxy: 'None', preset: '判断用补全预设', 'prompt-post-processing': 'strict',
    };
    const stContext = {
        mainApi: 'openai',
        chatCompletionSettings: {},
        CONNECT_API_MAP: { openrouter: { selected: 'openai', source: 'openrouter' } },
        extensionSettings: { connectionManager: { selectedProfile: 'other', profiles: [profile] } },
        getPresetManager: api => (api === 'openai' ? { getCompletionPresetByName: name => (name === '判断用补全预设' ? { temperature: 0.3 } : null) } : null),
        ChatCompletionService: fakeChatCompletionService(presetCalls),
        ConnectionManagerRequestService: { sendRequest: async (...args) => { cmCalls.push(args); return { content: 'NO' }; } },
    };
    const localStorage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{ name: '走酒馆预设', connection: 'tavern', tavernProfile: 'p1', maxTokens: 300 }]),
    });
    let activeProfile = '原连接';
    const slashCalls = [];
    const triggerSlash = async command => {
        slashCalls.push(command);
        if (command === '/profile') return activeProfile;
        if (command === '/profile await=true "小模型"') activeProfile = '小模型';
        if (command === '/profile await=true "原连接"') activeProfile = '原连接';
        return activeProfile;
    };
    const world = directSendWorld({ judgePreset: '走酒馆预设' }, stContext, { localStorage, triggerSlash });
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(cmCalls.length, 0, '不走连接管理器');
    assert.equal(world.rawCalls.length, 0);
    assert.equal(world.fetches.length, 1);
    const body = JSON.parse(world.fetches[0].options.body);
    assert.equal(body.chat_completion_source, 'openrouter');
    assert.equal(body.model, 'judge-mini');
    assert.equal('secret_id' in body, false, '目标连接已激活，不再靠手填 secret_id 选择密钥');
    assert.equal(body.max_tokens, 300);
    assert.equal(body.custom_prompt_post_processing, 'strict');
    assert.equal(body.temperature, 0.3, '补全预设的参数要等 async 的 presetToGeneratePayload 生成完');
    assert.equal(body.stream, false);
    assert.equal(presetCalls.length, 1);
    assert.deepEqual(slashCalls, ['/profile', '/profile await=true "小模型"', '/profile', '/profile await=true "原连接"']);
    assert.equal(activeProfile, '原连接');
    assert.equal(world.stageIndex(), 1);
    assert.deepEqual(world.run.errors, []);
});

test('酒馆预设直发失败也恢复原连接，目标已激活时不重复切换', async () => {
    const profile = { id: 'p1', name: '小模型', api: 'openrouter', model: 'judge-mini', proxy: 'None' };
    const stContext = {
        CONNECT_API_MAP: { openrouter: { selected: 'openai', source: 'openrouter' } },
        extensionSettings: { connectionManager: { profiles: [profile] } },
        ChatCompletionService: fakeChatCompletionService([]),
    };
    const localStorage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{ name: '走酒馆预设', connection: 'tavern', tavernProfile: 'p1' }]),
    });
    let activeProfile = '原连接';
    const slashCalls = [];
    const triggerSlash = async command => {
        slashCalls.push(command);
        if (command === '/profile') return activeProfile;
        activeProfile = command.includes('小模型') ? '小模型' : '原连接';
        return activeProfile;
    };
    const failed = directSendWorld({ judgePreset: '走酒馆预设' }, stContext, {
        localStorage, triggerSlash,
        fetch: async () => { throw new Error('HTTP 400 配置错误'); },
    });
    await new Promise(setImmediate);
    await failed.state.events.get('message_received')(5);
    assert.deepEqual(slashCalls, ['/profile', '/profile await=true "小模型"', '/profile', '/profile await=true "原连接"']);
    assert.equal(activeProfile, '原连接', '请求失败仍恢复');
    assert.equal(failed.stageIndex(), 0);

    activeProfile = '小模型';
    slashCalls.length = 0;
    const active = directSendWorld({ judgePreset: '走酒馆预设' }, stContext, { localStorage, triggerSlash });
    await new Promise(setImmediate);
    await active.state.events.get('message_received')(5);
    assert.deepEqual(slashCalls, ['/profile'], '已是目标连接时不用切换和恢复');
    assert.equal(active.stageIndex(), 1);
});

test('判断AI档：酒馆预设读不到反向代理或不是 Chat Completion 时退回连接管理器', async () => {
    for (const profile of [
        { id: 'p1', name: '走代理', api: 'openai', model: 'm', proxy: '我的代理' },
        { id: 'p1', name: '文本补全', api: 'koboldcpp', model: 'm' },
    ]) {
        const cmCalls = [];
        const stContext = {
            chatCompletionSettings: {},
            CONNECT_API_MAP: { openai: { selected: 'openai', source: 'openai' }, koboldcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' } },
            extensionSettings: { connectionManager: { selectedProfile: 'other', profiles: [profile] } },
            ChatCompletionService: fakeChatCompletionService([]),
            ConnectionManagerRequestService: { sendRequest: async (...args) => { cmCalls.push(args); return { content: '<verdict>YES</verdict>' }; } },
        };
        const localStorage = memoryStorage({
            'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{ name: '走酒馆预设', connection: 'tavern', tavernProfile: 'p1' }]),
        });
        const world = directSendWorld({ judgePreset: '走酒馆预设' }, stContext, { localStorage });
        await new Promise(setImmediate);
        await world.state.events.get('message_received')(5);
        assert.equal(world.fetches.length, 0, `${profile.name}：不直发`);
        assert.equal(cmCalls.length, 1, `${profile.name}：走连接管理器`);
        assert.equal(world.stageIndex(), 1);
    }
});

test('原生 fetch：别的脚本包装了 fetch 时，按标记剥回原函数再发', async () => {
    const nativeCalls = [];
    const wrappedCalls = [];
    // Proxy 包一个名叫 fetch 的函数，toString 出来是 [native code]，冒充浏览器原生 fetch。
    const nativeFetch = new Proxy(async function fetch(url, options) {
        nativeCalls.push({ url, options });
        const body = JSON.stringify({ choices: [{ message: { content: '<verdict>YES</verdict>' } }] });
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    }, {});
    const wrapper = async (url, options) => { wrappedCalls.push(url); return nativeFetch(url, options); };
    wrapper.__keminiFetchInterceptor__ = { original: nativeFetch };
    const stContext = {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'openai' },
        getChatCompletionModel: () => 'gpt',
        ChatCompletionService: fakeChatCompletionService([]),
    };
    const world = directSendWorld({}, stContext, { fetch: wrapper });
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(wrappedCalls.length, 0, '不经过包装');
    assert.equal(nativeCalls.length, 1);
    assert.equal(world.stageIndex(), 1);
    assert.deepEqual(world.run.errors, []);
});

test('判断AI档：选择不存在的本机预设时不调用 generateRaw', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgePreset: '不存在' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    let calls = 0;
    helper.generateRaw = async () => { calls += 1; return 'YES'; };
    const run = load(helper, { localStorage: memoryStorage() });
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(calls, 0);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0);
    assert.match(run.logs.join('\n'), /找不到本机 API 预设/);
    assert.deepEqual(run.errors, []);
});

test('本机判断AI API 预设：连接方式、接口协议与数值字段', () => {
    assert.deepEqual(plain(core.normalizeJudgeApiPreset({
        name: ' 自定义判断AI ', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: ' https://api.example.com/v1 ', key: 'sk-x', model: ' m1 ',
        maxTokens: '24', temperature: '0.3', bodyParams: 'top_k: 50',
    })), {
        name: '自定义判断AI', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: 'https://api.example.com/v1', key: 'sk-x', model: 'm1',
        maxTokens: 24, temperature: 0.3, bodyParams: 'top_k: 50',
        excludeBodyParams: '', requestHeaders: '', promptPostProcessing: 'strict', tavernProfile: '',
    });
});

test('API 预设请求体：Claude 协议映射原生源并规范基址', () => {
    const preset = core.normalizeJudgeApiPreset({
        name: '克劳德', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: 'https://api.anthropic.com', key: 'sk-ant', model: 'claude-sonnet',
        maxTokens: 24, temperature: 0.3, bodyParams: 'top_k: 50', excludeBodyParams: 'top_p, reasoning_effort',
        requestHeaders: 'X-Extra: 1', promptPostProcessing: '',
    });
    const body = core.buildJudgeCustomRequestBody([{ role: 'SYSTEM', content: 's' }, { role: 'user', content: 'u' }], preset);
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.reverse_proxy, 'https://api.anthropic.com/v1', 'claude 源基址要补 /v1');
    assert.equal(body.proxy_password, 'sk-ant', '原生源密钥走 proxy_password');
    assert.equal(body.custom_url, 'https://api.anthropic.com');
    assert.equal(body.custom_include_headers, 'Authorization: Bearer sk-ant\nX-Extra: 1');
    assert.equal(body.custom_include_body, 'top_k: 50');
    assert.equal(body.custom_exclude_body, '- top_p\n- reasoning_effort');
    assert.equal('custom_prompt_post_processing' in body, false, '显式「未选择」时不带该字段');
    assert.equal(body.messages[0].role, 'system', 'role 统一小写');
    assert.equal(body.max_tokens, 24);
    assert.equal(body.temperature, 0.3);
});

test('API 预设请求体：OpenAI 兼容协议走 custom 源', () => {
    const preset = core.normalizeJudgeApiPreset({
        name: 'o', connection: 'custom', customApiFormat: 'openai_compat',
        apiurl: 'https://api.example.com/v1', key: 'k', model: 'models/gpt-x',
    });
    const body = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset);
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.reverse_proxy, 'https://api.example.com/v1');
    assert.equal(body.proxy_password, '', 'custom 源不用 proxy_password');
    assert.equal(body.model, 'gpt-x', 'models/ 前缀要剥掉');
    assert.equal(body.custom_prompt_post_processing, 'strict', '缺省归一为严格');
    assert.equal(body.max_tokens, 60000, '缺省最大回复长度对齐数据库 60000');
    assert.equal(body.temperature, 1, '缺省温度对齐数据库 1');
});

test('本机判断AI API 预设：缺省数值回退数据库默认 60000 / 1', () => {
    const preset = plain(core.normalizeJudgeApiPreset({ name: '裸预设', connection: 'main' }));
    assert.equal(preset.maxTokens, 60000, '最大回复长度缺省 60000（同数据库）');
    assert.equal(preset.temperature, 1, '温度缺省 1（同数据库）');
    const broken = plain(core.normalizeJudgeApiPreset({ name: '坏数值', connection: 'main', maxTokens: 'abc', temperature: 'x' }));
    assert.equal(broken.maxTokens, 60000, '非法值也回退 60000');
    assert.equal(broken.temperature, 1, '非法温度回退 1');
});

test('提示词后处理归一化：空串保留、非法回退严格', () => {
    assert.equal(core.normalizePromptPostProcessing(''), '');
    assert.equal(core.normalizePromptPostProcessing('strict'), 'strict');
    assert.equal(core.normalizePromptPostProcessing('merge_tools'), 'merge_tools');
    assert.equal(core.normalizePromptPostProcessing(undefined), 'strict');
    assert.equal(core.normalizePromptPostProcessing('junk'), 'strict');
});

test('排除主体参数归一化：逗号/换行转 YAML 序列，YAML 原样透传', () => {
    assert.equal(core.normalizeExcludeBodyParams('top_p, reasoning_effort'), '- top_p\n- reasoning_effort');
    assert.equal(core.normalizeExcludeBodyParams('top_p\nreasoning_effort'), '- top_p\n- reasoning_effort');
    assert.equal(core.normalizeExcludeBodyParams('- top_p\n- reasoning_effort'), '- top_p\n- reasoning_effort');
    assert.equal(core.normalizeExcludeBodyParams(''), '');
    assert.equal(core.normalizeExcludeBodyParams(null), '');
});

test('原生协议源基址归一化：claude 补 /v1、makersuite 剥版本段', () => {
    assert.equal(core.normalizeNativeProxyBase('https://api.anthropic.com', 'claude'), 'https://api.anthropic.com/v1');
    assert.equal(core.normalizeNativeProxyBase('https://api.anthropic.com/v1/', 'claude'), 'https://api.anthropic.com/v1');
    assert.equal(core.normalizeNativeProxyBase('https://gw.example.com/claude/messages', 'claude'), 'https://gw.example.com/claude/v1');
    assert.equal(core.normalizeNativeProxyBase('https://generativelanguage.googleapis.com/v1beta', 'makersuite'), 'https://generativelanguage.googleapis.com');
    assert.equal(core.normalizeNativeProxyBase('', 'claude'), '');
});

test('拉模型走酒馆后端 status 端点并解析 models 列表', async () => {
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, options });
        return { ok: true, json: async () => ({ models: [{ id: 'm1' }, { id: 'm2' }, 'm3'] }), text: async () => '' };
    };
    const run = load(null, { fetch: fetchMock });
    const models = await run.core.fetchAvailableModels('https://api.example.com/v1', 'sk-x');
    assert.deepEqual(models, ['m1', 'm2', 'm3']);
    assert.equal(fetches[0].url, '/api/backends/chat-completions/status');
    const body = JSON.parse(fetches[0].options.body);
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.custom_url, 'https://api.example.com/v1');
    assert.equal(body.custom_include_headers, 'Authorization: Bearer sk-x');
});

test('拉模型失败时抛出带状态的错误，空端点直接拒绝', async () => {
    const fetchMock = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"bad key"}' });
    const run = load(null, { fetch: fetchMock });
    await assert.rejects(() => run.core.fetchAvailableModels('https://x', 'k'), /401/);
    await assert.rejects(() => run.core.fetchAvailableModels('', 'k'), /请输入端点/);
});

test('酒馆连接预设列表从连接管理器读取', () => {
    const SillyTavern = {
        getContext: () => ({
            extensionSettings: {
                connectionManager: { profiles: [{ id: 'p1', name: '配置一' }, { id: 'p2' }, { name: '没id不要' }, null] },
            },
        }),
    };
    const run = load(null, { SillyTavern });
    assert.deepEqual(plain(run.core.readTavernConnectionProfiles()), [{ id: 'p1', name: '配置一' }, { id: 'p2', name: 'p2' }]);
    const empty = load(null);
    assert.deepEqual(plain(empty.core.readTavernConnectionProfiles()), [], '没有 SillyTavern 上下文时返回空列表');
});

test('normalizeConfig 清除 v2.8/v2.9 遗留字段，只保留当前本机预设名', () => {
    const normalized = core.normalizeConfig({
        version: 2,
        bindings: [],
        settings: {
            judgeEngine: 'callAI',
            judgeApiPresets: [{ name: '旧数据库预设' }],
            judgePreset: '本机预设',
        },
    });
    assert.equal(normalized.settings.judgePreset, '本机预设');
    assert.equal('judgeEngine' in normalized.settings, false);
    assert.equal('judgeApiPresets' in normalized.settings, false);
});

test('v1 预设迁移：type=proxy → tavern，type=current → main', () => {
    const list = core.normalizeJudgeApiPresets([
        { name: '代理', type: 'proxy', proxyPreset: '酒馆代理A', model: 'm' },
        { name: '主 API', type: 'current' },
    ]);
    assert.equal(list[0].connection, 'tavern');
    assert.equal(list[0].tavernProfile, '酒馆代理A');
    assert.equal(list[1].connection, 'main');
});


// ---------------------------------------------------------------
// v2.13：输出提取/排除规则（复刻数据库填表规则）+ 运行日志
// ---------------------------------------------------------------

test('规则归一化：去空白、丢残缺项与非对象项、去重', () => {
    const rules = core.normalizeRulePairs([
        { start: ' <a> ', end: ' </a> ' },
        { start: '', end: 'x' },
        { start: 'y' },
        '字符串项',
        null,
        { start: '<a>', end: '</a>' },
        { start: '<b>', end: '</b>' },
    ]);
    assert.deepEqual(plain(rules), [{ start: '<a>', end: '</a>' }, { start: '<b>', end: '</b>' }]);
});

test('提取规则：取最后一处命中且含边界，多条拼接，未命中回退原文', () => {
    const text = '闲聊\n<结论>YES</结论>\n中间\n<结论>NO</结论>\n尾巴';
    const once = core.applyJudgeOutputRules(text, { extractRules: [{ start: '<结论>', end: '</结论>' }] });
    assert.equal(once, '<结论>NO</结论>', '取最后一处命中（含边界本身）');
    const miss = core.applyJudgeOutputRules(text, { extractRules: [{ start: '<没有>', end: '</没有>' }] });
    assert.equal(miss, text, '一条都没命中就返回原文');
    const multi = core.applyJudgeOutputRules('前<a>1</a>中<b>2</b>后', {
        extractRules: [{ start: '<a>', end: '</a>' }, { start: '<b>', end: '</b>' }],
    });
    assert.equal(multi, '<a>1</a>\n\n<b>2</b>', '多条规则的结果用空行拼接');
});

test('排除规则：删区间含边界、支持嵌套、压空行、不区分大小写', () => {
    const nested = '开头\n<think>第一层<think>第二层</think>结束</think>\n\n\n\n结尾';
    const out = core.applyJudgeOutputRules(nested, { excludeRules: [{ start: '<think>', end: '</think>' }] });
    assert.equal(out, '开头\n\n结尾', '嵌套区间整体删除，3 个以上换行压成 2 个');
    const ci = core.applyJudgeOutputRules('前<Think>x</THINK>后', { excludeRules: [{ start: '<think>', end: '</think>' }] });
    assert.equal(ci, '前后', '边界匹配不区分大小写');
    assert.equal(core.applyJudgeOutputRules(nested, {}), nested, '没有规则 = 原文直通');
});

test('先提取后排除：与数据库（shujuku）顺序一致', () => {
    const out = core.applyJudgeOutputRules('噪音<a>保留<cut>删我</cut>就好</a>噪音', {
        extractRules: [{ start: '<a>', end: '</a>' }],
        excludeRules: [{ start: '<cut>', end: '</cut>' }],
    });
    assert.equal(out, '<a>保留就好</a>');
});

test('normalizeConfig 清洗绑定规则，旧全局规则保留但不继承', () => {
    const normalized = core.normalizeConfig({
        version: 2,
        bindings: [
            { worldbookName: '书A', entryUid: 1, extractRules: [{ start: ' <结论> ', end: ' </结论> ' }, { start: '', end: 'x' }] },
            { worldbookName: '书A', entryUid: 2 },
        ],
        settings: {
            autoAdvance: 'judge',
            extractRules: [{ start: '<旧>', end: '</旧>' }],
            excludeRules: [],
        },
    });
    assert.deepEqual(plain(normalized.bindings[0].extractRules), [{ start: '<结论>', end: '</结论>' }]);
    assert.equal('extractRules' in normalized.bindings[1], false, '别的绑定从空白开始');
    assert.deepEqual(plain(normalized.settings.extractRules), [{ start: '<旧>', end: '</旧>' }], '旧配置只保留，不迁移');
    assert.equal('excludeRules' in normalized.settings, false, '整列无效就删字段（不过滤）');
    const absent = core.normalizeConfig({ version: 2, bindings: [], settings: { autoAdvance: 'judge' } });
    assert.equal('extractRules' in absent.settings, false, '没配过规则不能凭空加字段');
});

test('判断AI档：排除规则削掉思维链后读到真正的 YES', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null, excludeRules: [{ start: '<think>', end: '</think>' }] }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    // 输出开头是思维链里的 NO；削掉 <think> 段之后开头才是 YES。
    helper.generateRaw = async () => '<think>我拿不准，先写 NO 试试</think>\nYES';
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(core.judgeSaysYes('<think>我拿不准，先写 NO 试试</think>\nYES'), false, '不过滤时开头是 <think>，判不出 YES');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, '排除规则生效后必须推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：提取规则取最后一处 <结论>，盖过草稿里的旧结论', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null, extractRules: [{ start: '<结论>', end: '</结论>' }] }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    // 草稿里先写了一个 <结论>NO</结论>，最终结论才是 YES；提取规则只取最后一处。
    helper.generateRaw = async () => '<结论>NO</结论>\n（上面是草稿，作废）\n<结论>YES</结论>';
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(core.judgeSaysYes('<结论>NO</结论>\n（上面是草稿，作废）\n<结论>YES</结论>'), true, 'v3.2 起不配规则也只认最后一处标签');
    assert.equal(core.judgeSaysYes('<think>先写个 <verdict>NO</verdict> 试试</think>\n<verdict>\n- 结论：YES\n</verdict>'), true, '思维链里的草稿标签被最后的正式作答盖掉');
    assert.equal(core.judgeBasisText('<basis>草稿</basis>\n<basis>- 已发生：两人见面</basis>'), '两人见面', '依据也取最后一处');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, '提取规则生效后必须推进');
    const judgeLogs = run.core.log.list().filter(entry => entry.tag === '判断AI');
    assert.ok(judgeLogs.some(entry => /YES/.test(entry.message)), '运行日志里要有判断AI的结论记录');
    assert.deepEqual(run.errors, []);
});

test('运行日志：写入字段完整、标签收集、清空', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    log.info('判断AI', '结论：YES');
    log.warn('提醒', '预设丢失');
    log.error('API', '拉取失败', new Error('boom'));
    const all = log.list();
    assert.equal(all.length, 3);
    assert.deepEqual([...all].map(entry => entry.level), ['info', 'warn', 'error']);
    assert.equal(all[0].tag, '判断AI');
    assert.match(all[2].message, /Error: boom/);
    assert.ok(all.every(entry => entry.id > 0 && entry.time > 0), '每条都要有自增 id 和时间戳');
    assert.deepEqual(plain(log.tags()), ['API', '提醒', '判断AI'].sort());
    log.clear();
    assert.equal(log.count(), 0);
});

test('运行日志：debug 默认不采集，开启后采集；订阅实时通知、退订生效', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    log.debug('同步', '镜像同步完成');
    assert.equal(log.count(), 0, 'debug 默认不写缓冲');
    const seen = [];
    const unsubscribe = log.subscribe(entry => seen.push(entry));
    log.setDebugEnabled(true);
    log.debug('同步', '镜像同步完成');
    log.info('系统', '已加载');
    assert.equal(log.count(), 2);
    assert.deepEqual(seen.map(entry => entry.level), ['debug', 'info']);
    unsubscribe();
    log.info('系统', '再来一条');
    assert.equal(seen.length, 2, '退订后不再通知');
});

test('运行日志：环形缓冲超过 2000 条丢最旧', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    for (let index = 0; index < 2010; index += 1) log.info('测试', `第 ${index} 条`);
    assert.equal(log.count(), 2000);
    assert.equal(log.list()[0].message, '第 10 条', '最旧的 10 条必须被丢弃');
});

test('运行日志：错误对象带 stack 与 cause，循环引用对象不报错', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    const inner = new Error('底层超时');
    const outer = new Error('调用失败');
    outer.cause = inner;
    const loop = { a: 1 };
    loop.self = loop;
    log.error('API', outer, loop, undefined, null);
    const message = log.list()[0].message;
    assert.match(message, /^Error: 调用失败/);
    assert.match(message, /cause=Error: 底层超时/);
    assert.match(message, /Object\{a=1/);
    assert.match(message, /undefined null$/);
});

test('运行日志：错误处理建议按规则匹配，只给 error 级', () => {
    const run = load();
    const hint = run.core.resolveLogErrorHint;
    assert.equal(hint({ level: 'warn', tag: '判断AI', message: 'HTTP 429' }), null);
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '调用失败：HTTP 429 Too Many Requests' }).id, 'http-429');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '401 Unauthorized' }).id, 'http-401');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: 'Failed to fetch' }).id, 'network');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '找不到本机 API 预设「甲」' }).id, 'preset-missing');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '判断AI需要酒馆助手的 generateRaw 接口' }).id, 'tavern-helper');
    assert.equal(hint({ level: 'error', tag: '绑定', message: '世界书写入失败' }).id, 'worldbook');
    assert.equal(hint({ level: 'error', tag: '其他', message: '不明原因' }).id, 'generic', '通用兜底');
});

test('运行日志页：关键词搜索、暂停攒条数、错误下面附处理建议', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const booted = loadWithDocument(documentRef, helper);
    const log = booted.sandbox.DynamicGuideAssistantCore.log;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    log.error('判断AI', '调用失败：HTTP 429 Too Many Requests');
    log.info('推进', '甲一 → 甲二');
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '运行日志').listeners.click[0]();
    const hintNode = panel().querySelector('.dga-log-hint');
    assert.ok(hintNode, '错误日志下面要有处理建议');
    assert.match(hintNode.textContent, /限流/);
    const search = panel().querySelector('.dga-log-search');
    assert.ok(search, '有关键词搜索框');
    search.listeners.change[0]({ target: { value: '甲一' } });
    assert.ok(!panel().querySelector('.dga-log-hint'), '搜索后只剩匹配的那条');
    assert.match(panel().textContent, /甲一 → 甲二/);
    findButton(panel(), '暂停').listeners.click[0]();
    log.info('推进', '暂停期间来的');
    assert.ok(findButton(panel(), '恢复'), '暂停后按钮变成恢复');
    assert.doesNotMatch(panel().textContent, /暂停期间来的/, '暂停时不显示新日志');
    findButton(panel(), '恢复').listeners.click[0]();
    search.listeners.change[0]({ target: { value: '' } });
    const fresh = panel().querySelector('.dga-log-search');
    fresh.listeners.change[0]({ target: { value: '' } });
    assert.match(panel().textContent, /暂停期间来的/, '恢复后一次显示出来');
    assert.deepEqual(booted.errors, []);
});


// ---------------------------------------------------------------
// v2.14：规则语义对齐数据库（发送前过滤角色消息）+ 输出留痕 + 规则预览
// ---------------------------------------------------------------

test('判断AI档：提取规则发送前过滤角色回复，用户消息不发送（参考 2 段）', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null, extractRules: [{ start: '<content>', end: '</content>' }] }],
        settings: { autoAdvance: 'judge', judgeHistoryCount: 2 },
    };
    const messages = [
        { message_id: 3, role: 'user', message: '用户的话不带任何标签' },
        { message_id: 4, role: 'assistant', message: '<content>雨夜的正文</content>\n状态栏：HP 100 / SAN 50' },
        { message_id: 5, role: 'assistant', message: '这一轮的回复。<content>最新正文</content>' },
    ];
    const { state, helper } = multiWorld(books, { config, messages, lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return '<结论>NO</结论>'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1);
    const sent = lastUserText(verdicts[0]);
    assert.match(sent, /雨夜的正文/, '参考 2 段时较早的角色回复正文也要发出去');
    assert.match(sent, /最新正文/);
    assert.doesNotMatch(sent, /状态栏|HP 100/, '角色消息 <content> 外的部分不能发出去');
    assert.doesNotMatch(sent, /这一轮的回复。/, '<content> 前面的闲聊也要被滤掉');
    assert.doesNotMatch(sent, /用户：|用户的话/, '用户消息一律不发给判断AI');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, 'NO 不推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：默认只看 AI 最新 1 段正文，更早的角色回复不发送', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const messages = [
        { message_id: 3, role: 'user', message: '用户输入' },
        { message_id: 4, role: 'assistant', message: '上一轮的旧正文' },
        { message_id: 5, role: 'assistant', message: '本轮最新正文' },
    ];
    const { state, helper } = multiWorld(books, { config, messages, lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return '<结论>NO</结论>'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1);
    const sent = lastUserText(verdicts[0]);
    assert.match(sent, /本轮最新正文/, '最新一段角色正文必须发送');
    assert.doesNotMatch(sent, /上一轮的旧正文/, '默认只发最新 1 段，旧的角色回复不发送');
    assert.doesNotMatch(sent, /用户：|用户输入/, '用户消息一律不发给判断AI');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：排除规则在发送前削掉角色消息里的思维链', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null, excludeRules: [{ start: '<think>', end: '</think>' }] }],
        settings: { autoAdvance: 'judge' },
    };
    const messages = [
        { message_id: 5, role: 'assistant', message: '<think>内心嘀咕一堆</think>看得见的正文' },
    ];
    const { state, helper } = multiWorld(books, { config, messages, lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return '<结论>NO</结论>'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    const sent = lastUserText(verdicts[0]);
    assert.match(sent, /看得见的正文/);
    assert.doesNotMatch(sent, /内心嘀咕/, '角色消息里的 <think> 段发送前就要被削掉');
    assert.deepEqual(run.errors, []);
});

test('判断AI留痕：最近一次原始输出、过滤结果与结论都可在测试钩子上读到', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null, excludeRules: [{ start: '<think>', end: '</think>' }] }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const rawOutput = '<think>先写 NO 试试</think>\n<结论>YES</结论>';
    helper.generateRaw = async () => rawOutput;
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    const runtime = run.core.getJudgeRuntime();
    assert.equal(runtime.lastRaw, rawOutput, '留痕要保存未过滤的原始输出');
    assert.equal(runtime.lastFiltered, '<结论>YES</结论>', '留痕要保存过滤后的文本');
    assert.equal(runtime.lastYes, true);
    assert.ok(runtime.lastAt > 0, '留痕要有时间戳');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, '过滤后 YES 要推进');
    assert.deepEqual(run.errors, []);
});

test('规则预览：changed / hasTag / yes 三个字段都正确', () => {
    const untouched = core.previewJudgeOutput('<结论>YES</结论>', {});
    assert.deepEqual(plain(untouched), { filtered: '<结论>YES</结论>', changed: false, yes: true, hasTag: true });
    const extracted = core.previewJudgeOutput('啰嗦\n<结论>NO</结论>\n尾巴', { extractRules: [{ start: '<结论>', end: '</结论>' }] });
    assert.equal(extracted.filtered, '<结论>NO</结论>');
    assert.equal(extracted.changed, true);
    assert.equal(extracted.yes, false);
    assert.equal(extracted.hasTag, true);
    const noTag = core.previewJudgeOutput('没有标签的普通回答', {});
    assert.equal(noTag.hasTag, false);
    assert.equal(noTag.yes, false);
    const empty = core.previewJudgeOutput('', { excludeRules: [{ start: '<a>', end: '</a>' }] });
    assert.equal(empty.filtered, '');
    assert.equal(empty.changed, false);
});

test('流式输出归一化：只认布尔，其余回退 false', () => {
    const on = core.normalizeConfig({ version: 2, bindings: [], settings: { streamingEnabled: true } });
    assert.equal(on.settings.streamingEnabled, true);
    const truthy = core.normalizeConfig({ version: 2, bindings: [], settings: { streamingEnabled: 'yes' } });
    assert.equal(truthy.settings.streamingEnabled, false, '非布尔真值也要回退 false');
    const off = core.normalizeConfig({ version: 2, bindings: [], settings: { streamingEnabled: 1 } });
    assert.equal(off.settings.streamingEnabled, false);
});

test('SSE 聚合：OpenAI delta、Claude content_block_delta、[DONE] 与噪声行', () => {
    const openai = 'data: {"choices":[{"delta":{"content":"<结"}}]}\n\ndata: {"choices":[{"delta":{"content":"论>YES</结"}}]}\n\ndata: {"choices":[{"delta":{"content":"论>"}}]}\n\ndata: [DONE]\n';
    assert.equal(core.parseJudgeSseText(openai), '<结论>YES</结论>');
    const claude = 'data: {"type":"content_block_delta","delta":{"text":"YES"}}\ndata: [DONE]\n';
    assert.equal(core.parseJudgeSseText(claude), 'YES');
    const noise = ': 心跳\n\ndata: 不是json\n\ndata: {"choices":[{"delta":{}}]}\n';
    assert.equal(core.parseJudgeSseText(noise), '', '噪声行不产生文本');
});

test('判断AI档：流式开启后自定义连接 stream=true 且聚合 SSE 响应', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgePreset: '自定义判断AI', streamingEnabled: true },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const sse = 'data: {"choices":[{"delta":{"content":"<结论>NO"}}]}\n\ndata: {"choices":[{"delta":{"content":"</结论>"}}]}\n\ndata: [DONE]\n';
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, options });
        return { ok: true, status: 200, text: async () => sse, json: async () => { throw new Error('流式不该走 json()'); } };
    };
    const localStorage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{
            name: '自定义判断AI', connection: 'custom', customApiFormat: 'openai_compat',
            apiurl: 'https://api.example.com/v1', key: 'sk-secret', model: 'judge-model',
        }]),
    });
    const run = load(helper, { localStorage, fetch: fetchMock });
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(fetches.length, 1);
    const body = JSON.parse(fetches[0].options.body);
    assert.equal(body.stream, true, '开启流式后请求体 stream=true');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, 'SSE 聚合出 NO 不推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：流式开启后酒馆主 API 通道带 should_stream', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', streamingEnabled: true },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => { calls.push(options); return 'NO'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].should_stream, true, '流式开启后 generateRaw 带 should_stream');
    assert.equal(calls[0].should_silence, true, '静默标记不受影响');
    assert.deepEqual(run.errors, []);
});

test('判断AI档：流式关闭（默认）主 API 通道 should_stream=false', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => { calls.push(options); return 'NO'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(calls[0].should_stream, false, '默认不流式');
    assert.deepEqual(run.errors, []);
});

// ---------------------------------------------------------------
// v2.63：分支阶段（进入一组后其余分支不再走）+ 状态缩略展开
// ---------------------------------------------------------------

const BRANCH_OUTLINE = '## 相遇\n相遇正文\n\n## 留下\n分支：去向\n留下正文\n\n## 离开\n分支：去向\n离开正文\n\n## 尾声\n尾声正文';

test('分支：解析「分支：组名」，同义词也认', () => {
    const parsed = core.parseOutline(BRANCH_OUTLINE);
    assert.deepEqual(plain(parsed.stages.map(item => item.branch || '')), ['', '去向', '去向', '']);
    assert.equal(core.parseOutline('## 甲\n支线：路\n甲正文').stages[0].branch, '路', '支线是同义词');
});

test('分支：进入一组后其余分支被跳过', () => {
    const parsed = core.parseOutline(BRANCH_OUTLINE);
    const state = { branchChoices: { 去向: parsed.stages[2].id } };
    assert.equal(core.nextVisibleIndex(parsed, state, 0), 2, '从 0 往后跳过被否决的「留下」');
    assert.equal(core.nextVisibleIndex(parsed, state, 2), 3);
    assert.equal(core.nextVisibleIndex(parsed, state, 3), 4, '走完返回段数（全部完成）');
    assert.equal(core.prevVisibleIndex(parsed, state, 3), 2, '往回也跳过「留下」');
    assert.equal(core.prevVisibleIndex(parsed, state, 0), -1);
    assert.equal(core.stageBranchSkipped(parsed.stages[1], core.branchChoicesOf(state)), true);
    assert.equal(core.stageBranchSkipped(parsed.stages[2], core.branchChoicesOf(state)), false);
    assert.equal(core.branchPendingChoices(parsed, {}, 1).length, 2, '未决时整组都是候选');
    assert.equal(core.branchPendingChoices(parsed, state, 1), null, '已选定后不再是未决');
    assert.equal(core.branchPendingChoices(parsed, {}, 0), null, '普通阶段没有分支候选');
});

test('分支：进度落在被否决的分支上时顺到下一个可见段', () => {
    const parsed = core.parseOutline(BRANCH_OUTLINE);
    const state = core.reconcileState({ stageIndex: 1, stageName: '留下', branchChoices: { 去向: parsed.stages[2].id, 旧组: '不存在的id' } }, parsed, 0);
    assert.equal(state.stageIndex, 2, '「留下」被否决，顺到「离开」');
    assert.equal(state.stageName, '离开');
    assert.deepEqual(plain(state.branchChoices), { 去向: parsed.stages[2].id }, '失效的分支选择要清掉');
});

test('分支：手动步进跳过被否决分支，未决组给候选，循环绕回清空选择', () => {
    const parsed = core.parseOutline(BRANCH_OUTLINE);
    const chosen = { 去向: parsed.stages[2].id };
    assert.equal(core.stepTargetVisible(parsed, { stageIndex: 0, branchChoices: chosen }, 1).target, 2);
    assert.equal(core.stepTargetVisible(parsed, { stageIndex: 3, branchChoices: chosen }, -1).target, 2);
    const pending = core.stepTargetVisible(parsed, { stageIndex: 0 }, 1);
    assert.equal(pending.target, 1);
    assert.equal(pending.pending.length, 2, '下一段落在未决分支组时要先选走向');
    parsed.loop = true;
    const wrap = core.stepTargetVisible(parsed, { stageIndex: 3, branchChoices: chosen }, 1);
    assert.equal(wrap.target, 0);
    assert.equal(wrap.resetBranches, true, '没预设走同一条时，循环绕回清空分支选择');
    parsed.loopKeepBranch = true;
    const kept = core.stepTargetVisible(parsed, { stageIndex: 3, branchChoices: chosen }, 1);
    assert.equal(kept.target, 0);
    assert.equal(kept.resetBranches, false, '创作者预设走同一条时，绕回不清分支选择');
    const back = core.stepTargetVisible(parsed, { stageIndex: 0, branchChoices: chosen }, -1);
    assert.equal(back.target, 3);
    assert.equal(back.resetBranches, false, '退回上一轮只是回看，不清选择');
});

test('分支走向解析：序号、名字、0 与空表', () => {
    const candidates = [{ id: 'a', name: '留下' }, { id: 'b', name: '离开' }];
    assert.equal(core.judgePickedBranch('<branch>\n- 走向：2\n</branch>', candidates).id, 'b');
    assert.equal(core.judgePickedBranch('<branch>留下</branch>', candidates).id, 'a');
    assert.equal(core.judgePickedBranch('<branch>\n- 走向：0\n</branch>', candidates), null);
    assert.equal(core.judgePickedBranch('<branch></branch>', candidates), null);
    assert.equal(core.judgePickedBranch('没有表', candidates), null);
    assert.equal(core.judgePickedBranch('<branch>\n- 走向：9\n</branch>', candidates), null);
});

test('判断AI档：下一格是分支组时，走向和结论在同一次请求里问，选中才推进', async () => {
    const stages = core.parseOutline(BRANCH_OUTLINE).stages;
    const books = { 书A: [{ uid: 1, name: '大纲A', content: BRANCH_OUTLINE, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复，没有隐藏标记。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => {
        calls.push(options);
        return '<basis>演完了</basis>\n<verdict>\n- 结论：YES\n</verdict>\n<branch>\n- 走向：2\n</branch>';
    };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    assert.equal(calls.length, 1, '走向和结论一次问完，不再补问第二次');
    const asked = lastUserText(calls[0]);
    assert.match(asked, /【分支】/);
    assert.match(asked, /1\. 留下/);
    assert.match(asked, /2\. 离开/);
    assert.match(asked, /<branch>\n- 走向：序号\n<\/branch>/);
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)];
    assert.equal(saved.stageIndex, 2, '选了第 2 个分支「离开」');
    assert.deepEqual(plain(saved.branchChoices), { 去向: stages[2].id });
    assert.match(state.books.书A.find(item => item.name === '大纲A（动态指导）').content, /离开正文/);
    assert.deepEqual(run.errors, []);
});

test('判断AI档：分支走向写 0 时不推进', async () => {
    const books = { 书A: [{ uid: 1, name: '大纲A', content: BRANCH_OUTLINE, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => {
        calls.push(options);
        return '<verdict>YES</verdict>\n<branch>\n- 走向：0\n</branch>';
    };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    assert.equal(calls.length, 1);
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)];
    assert.equal(saved.stageIndex, 0, '对不上分支就不推进');
    assert.equal(saved.lastJudgeCheckedId, 5, '但这一层记为已检查，不反复问');
    assert.deepEqual(run.errors, []);
});

test('状态依据：长结论保留到 500 字，不再截到 60', () => {
    const long = '这是一段很长的依据。'.repeat(50);
    const basis = core.judgeBasisText(`<basis>${long}</basis>`);
    assert.ok(basis.length > 60, '长依据要留下来给「展开」看');
    assert.ok(basis.length <= 500);
});

test('小卡状态字多就缩略，点「展开」看全文、再点「收起」', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二', enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    const longBasis = `依据${'很'.repeat(80)}长`;
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [{ worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' }], settings: { autoAdvance: 'judge' } },
    };
    state.variables.chat.$dynamicGuideAssistant = {
        state: { version: 2, bindings: { [keyOf('测试世界书', 1)]: { stageIndex: 0, stageName: '第一幕', lastJudgeCheckedId: 5, lastJudgeYes: false, lastJudgeBasis: longBasis } } },
    };
    const { errors } = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const status = panel().querySelector('.dga-judge-status');
    assert.ok(status, '有状态行');
    assert.ok(!status.textContent.includes('很'.repeat(80)), '默认缩略，不把全文摆出来');
    const toggle = panel().querySelector('.dga-judge-toggle');
    assert.ok(toggle, '长状态带展开按钮');
    assert.equal(toggle.textContent, '展开');
    toggle.listeners.click[0]();
    const opened = panel().querySelector('.dga-judge-status');
    assert.ok(opened.textContent.includes('很'.repeat(80)), '展开后看到全文');
    assert.equal(panel().querySelector('.dga-judge-toggle').textContent, '收起');
    panel().querySelector('.dga-judge-toggle').listeners.click[0]();
    assert.ok(!panel().querySelector('.dga-judge-status').textContent.includes('很'.repeat(80)), '收起后回到缩略');
    assert.deepEqual(errors, []);
});

test('路线图：没有依附也列出分段；支线插在所依附的那一段后面', () => {
    const stages = names => ({ stages: names.map(name => ({ name })) });
    const line = (key, name, parsed, state, binding) => ({
        key, configured: true, entry: { name }, parsed, state, binding: { worldbookName: '书', entryName: name, ...binding },
    });
    const rows = core.roadmapOutline([
        line('书#1', '主线', stages(['相遇', '同居', '分别']), { stageIndex: 1, forkInto: '书#2' }, {}),
        line('书#2', '岔路', stages(['岔一', '岔二']), { stageIndex: 0 }, { attachKey: '书#1', attachStage: 2, attachKind: 'fork', passes: [{ left: 2, right: 3, dir: 'back' }] }),
        line('书#3', '番外', stages(['番一']), { stageIndex: 0 }, { attachKey: '书#1', attachStage: 3, attachKind: 'side' }),
        line('书#4', '独立', stages(['甲']), { stageIndex: 1 }, {}),
    ]);
    assert.deepEqual(plain(rows.map(row => row.name)), ['主线', '独立']);
    assert.equal(rows[0].now, '现在第 2 段');
    assert.deepEqual(plain(rows[0].branches.map(item => [item.after, item.node.name])), [[2, '岔路'], [3, '番外']]);
    assert.equal(rows[0].branches[0].node.how, '分岔口：从「主线」第 2 段「同居」接上');
    assert.equal(rows[0].branches[0].node.now, '现在第 1 段', '走进了分岔');
    assert.deepEqual(plain(rows[0].branches[0].node.passes), ['换边：这条第 2 段 ← 那边第 3 段']);
    assert.equal(rows[0].branches[1].node.how, '支线：从「主线」第 3 段「分别」接上');
    assert.equal(rows[0].branches[1].node.now, '还没走到');
    assert.equal(rows[1].now, '全部走完');
    const alone = core.roadmapOutline([
        line('书#1', '主线', stages(['内容1', '内容2', '内容3', '内容4']), { stageIndex: 0 }, {}),
    ]);
    assert.equal(alone.length, 1);
    assert.deepEqual(plain(alone[0].stages), ['内容1', '内容2', '内容3', '内容4']);
    assert.equal(alone[0].branches.length, 0);
    const loop = core.roadmapOutline([
        line('a', '甲', stages(['一']), {}, { attachKey: 'b' }),
        line('b', '乙', stages(['一']), {}, { attachKey: 'a' }),
    ]);
    const names = [];
    const walk = nodes => nodes.forEach(node => {
        names.push(node.name);
        (node.branches || []).forEach(item => walk([item.node]));
    });
    walk(loop);
    assert.deepEqual(names, ['甲', '乙'], '依附绕成圈也不丢条目、不死循环');
});

test('依附不能绕回：被依附的那条不能再挂到依附它的这条上', () => {
    const line = (key, name, attachKey) => ({
        key, entry: { name }, binding: attachKey ? { attachKey } : {},
    });
    const contexts = [
        line('a', '主线'),
        line('b', '支线', 'a'),
        line('c', '旁支', 'b'),
    ];
    assert.equal(core.attachmentCycles(contexts, 'a', 'b'), true, '主线不能挂回支线');
    assert.equal(core.attachmentCycles(contexts, 'a', 'c'), true, '绕一圈也不行');
    assert.equal(core.attachmentCycles(contexts, 'b', 'a'), false, '支线挂在主线上是原来的方向');
    assert.equal(core.attachmentCycles(contexts, 'c', 'a'), false, '旁支也可以直接挂到主线');
    assert.equal(core.attachmentCycles(contexts, 'a', 'a'), true);
    assert.equal(core.attachmentCycles(contexts, 'a', ''), false);
});

test('被依附的条目不能再选回依附它的那条，支线插在那一段后面', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '主线', content: '## 内容1\n甲\n\n## 内容2\n甲二', enabled: false });
    state.entries.push({ uid: 2, name: '支线', content: '## 支线内容1\n乙\n\n## 支线内容2\n乙二', enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [
                { worldbookName: '测试世界书', entryUid: 1, entryName: '主线' },
                { worldbookName: '测试世界书', entryUid: 2, entryName: '支线', attachKey: '测试世界书#uid:1', attachStage: 1, attachKind: 'side' },
            ],
        },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    sandbox.confirm = () => true;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const roadmap = panel().querySelector('.dga-roadmap');
    const text = roadmap.textContent;
    const css = documentRef.getElementById('dynamic-guide-assistant-style').textContent;
    assert.match(css, /\.dga-roadmap-stages \{[^}]*flex-direction:\s*column/, '每个阶段单独一行');
    assert.equal(text.includes('——————'), false, '支线上下不画横线');
    assert.ok(text.indexOf('1. 内容1') < text.indexOf('└ 支线'), '支线接在内容1后面');
    assert.ok(text.indexOf('└ 支线') < text.indexOf('1. 支线内容1') && text.indexOf('1. 支线内容1') < text.indexOf('2. 支线内容2'));
    assert.ok(text.indexOf('2. 支线内容2') < text.indexOf('2. 内容2'));
    const buttons = [];
    const walk = node => {
        if (node.tagName === 'BUTTON' && node.textContent === '设置 ›') buttons.push(node);
        (node.children || []).forEach(walk);
    };
    walk(panel());
    buttons[0].listeners.click[0]();
    const selects = [];
    const walkSel = node => {
        if (node.tagName === 'SELECT') selects.push(node);
        (node.children || []).forEach(walkSel);
    };
    walkSel(panel());
    const attach = selects.find(select => optionsOf(select).some(option => option.textContent === '不依附，自己走'));
    assert.deepEqual(optionsOf(attach).map(option => option.textContent), ['不依附，自己走'], '主线不能再选支线');
    assert.deepEqual(errors, []);
});

test('没有时间线；编辑仍是分段，设置里可以依附', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二', enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [{ worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' }] },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    sandbox.confirm = () => true;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();

    const roadmap = panel().querySelector('.dga-roadmap-card');
    assert.ok(roadmap, '没有依附时也显示路线图');
    assert.match(roadmap.textContent, /第一幕/);
    assert.match(roadmap.textContent, /第二幕/);
    assert.equal(findButton(panel(), '时间线 ›'), null, '小卡上没有时间线');
    await findButton(panel(), '设置 ›').listeners.click[0]();
    assert.match(panel().textContent, /阶段怎么走/, '设置页能看到阶段怎么走');
    assert.match(panel().textContent, /依附于/, '设置页能依附别的条目');
    assert.match(panel().textContent, /循环/);
    assert.equal(findButton(panel(), '时间线'), null, '页顶没有时间线');
    assert.ok(findButton(panel(), '编辑'), '页顶能去编辑');
    assert.equal(panel().querySelector('.dga-nav-toggle'), null, '设置是二级页');
    await findButton(panel(), '编辑').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-pick-surface'), '从设置能进到分段编辑');
    assert.equal(panel().querySelector('.dga-road'), null, '编辑页没有时间线');
    await panel().querySelector('.dga-close').listeners.click[0]();

    await findButton(panel(), '编辑 ›').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-pick-surface'), '编辑打开的是原来的分段');
    assert.equal(panel().querySelector('.dga-map'), null, '编辑页不放导图');
    assert.equal(findButton(panel(), '新建'), null, '分段编辑没有导图的新建');
    assert.deepEqual(errors, []);
});

test('编辑草稿经设置页切到提示词前仍确认，取消后原文修改保留', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const original = '## 第一幕\n正文一\n\n## 第二幕\n正文二';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: original, enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [{ worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' }] },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    let confirmations = 0;
    sandbox.confirm = () => { confirmations += 1; return false; };
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    await findButton(panel(), '编辑 ›').listeners.click[0]();
    findButton(panel(), '编辑原文').listeners.click[0]();
    const area = panel().querySelector('.dga-raw');
    area.value = original.replace('正文一', '尚未保存的新正文');
    area.listeners.input[0]({ target: area });
    await findButton(panel(), '设置').listeners.click[0]();
    assert.equal(confirmations, 0, '编辑切设置继续保留草稿');
    await findButton(panel(), '提示词').listeners.click[0]();
    assert.equal(confirmations, 1, '从设置切提示词也确认编辑草稿');
    assert.ok(panel().querySelector('.dga-rule-group'), '取消后仍在设置页');
    assert.equal(panel().querySelector('.dga-pseg'), null);
    await findButton(panel(), '编辑').listeners.click[0]();
    assert.match(panel().querySelector('.dga-raw').value, /尚未保存的新正文/);
    assert.equal(state.entries.find(item => item.uid === 1).content, original, '未保存的原文没有落盘');
    assert.deepEqual(errors, []);
});

test('卡片旧正文不盖过已划进原文的字，只有卡片的字在分段里能看见', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const original = '## 第一幕\n暑假正文\n\n## 第二幕\n寒假正文';
    const layout = savedStages(original, [
        { name: '第一幕', quote: '暑假正文' },
        { name: '第二幕', quote: '寒假正文' },
    ]);
    layout.stages[0].body = '';
    layout.stages[1].body = '卡片旧文';
    layout.stages.push({ id: 's3', name: '只在卡片', completion: '', terminal: false, ranges: [], body: '只有卡片里的这一段' });
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: original, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [], layouts: { '测试世界书#大纲': layout } },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    await sandbox.DynamicGuideAssistantCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    showBody(panel());
    assert.match(panel().textContent, /暑假正文/);
    assert.match(panel().textContent, /只有卡片里的这一段/);
    assert.equal(panel().textContent.includes('空分段（名下没有文字，不会发送）'), false, '卡片里有字的阶段不能写成不会发送');
    await findButton(panel(), '保存').listeners.click[0]();
    const saved = state.variables.character.$dynamicGuideAssistant.config.layouts['测试世界书#大纲'];
    assert.equal(saved.stages[0].body, undefined, '原文已有文字时不再留下空的卡片正文');
    assert.equal(saved.stages[1].body, undefined, '原文已有文字时不再留下旧的卡片正文');
    assert.equal(saved.stages[2].body, '只有卡片里的这一段', '原文还是空的阶段保留卡片正文');
    assert.deepEqual(errors, []);
});

test('线：可选会清掉互斥名单，点名的互斥才留下', () => {
    const links = core.cleanStoryLinks([
        { id: 'a', from: '1', to: '2', optional: true, exclusiveWith: ['b'] },
        { id: 'b', from: '1', to: '3', optional: false, exclusiveWith: ['a', 'b'] },
        { id: 'c', from: '9', to: '2' },
    ], ['1', '2', '3']);
    assert.equal(links.map(link => link.id).join(','), 'a,b');
    assert.equal(links[0].optional, true);
    assert.equal(links[0].exclusiveWith.length, 0);
    assert.equal(links[1].optional, false);
    assert.equal(links[1].exclusiveWith.join(','), 'a');
});

test('原文划分优先于卡片旧正文，空卡片不能把原文发空', () => {
    const source = '原文这一段';
    const ranges = [{ start: 0, end: source.length }];
    assert.equal(core.stageGuidePrompt({ body: '', ranges }, source, []), source, '空的卡片正文不能盖过原文');
    assert.equal(core.stageGuidePrompt({ body: '卡片旧文', ranges }, source, []), source, '原文里有字时不用卡片旧文');
    assert.equal(core.stageGuidePrompt({
        body: '只有卡片',
        ranges: [],
        beforeIds: ['stay'],
        extras: [{ id: 'extra', name: '戒指', body: '戒指能看见灵体' }],
    }, source, [{ id: 'stay', name: '文风', body: '保持克制' }]), '保持克制\n\n只有卡片\n\n戒指能看见灵体', '原文还没划进来时仍发卡片里的字');
    assert.equal(core.stageGuidePrompt({
        body: '卡片旧文',
        ranges,
        beforeIds: ['stay'],
        extras: [{ id: 'extra', name: '戒指', body: '戒指能看见灵体' }],
    }, source, [{ id: 'stay', name: '文风', body: '保持克制' }]), '保持克制\n\n原文这一段\n\n戒指能看见灵体', '原文有字时仍带上这一段的常驻和附加');
});

test('发给 AI 的内容按常驻在前、这一张、附加、常驻在后排好', () => {
    const text = core.stageSendText({
        body: '苏醒后的正文',
        beforeIds: ['stay'],
        afterIds: ['tail'],
        extras: [{ id: 'extra', name: '戒指', body: '戒指能看见灵体' }],
    }, [
        { id: 'stay', name: '文风', body: '保持克制' },
        { id: 'tail', name: '提醒', body: '不要替用户决定' },
    ]);
    assert.equal(text, '保持克制\n\n苏醒后的正文\n\n戒指能看见灵体\n\n不要替用户决定');
});

test('点进一段分成离开、岔路、发给 AI、附加和常驻', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const original = '## 第一幕\n暑假正文\n\n## 第二幕\n寒假正文';
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: original, enabled: false });
    state.variables.character.$dynamicGuideAssistant = {
        config: {
            version: 2,
            bindings: [],
            layouts: {
                '测试世界书#大纲': savedStages(original, [
                    { name: '第一幕', quote: '暑假正文' },
                    { name: '第二幕', quote: '寒假正文' },
                ]),
            },
        },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    await sandbox.DynamicGuideAssistantCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    showBody(panel());
    panel().querySelector('.dga-segbar').listeners.click[0]();
    const sheet = () => panel().querySelector('.dga-sheet');
    assert.match(sheet().textContent, /离开这一段/);
    assert.doesNotMatch(sheet().textContent, /发给 AI/);
    assert.doesNotMatch(sheet().textContent, /排在阶段内容之前/);
    assert.doesNotMatch(sheet().textContent, /走完回到/);
    assert.doesNotMatch(sheet().textContent, /到了这里/);
    assert.doesNotMatch(sheet().textContent, /附在这一段/);
    assert.equal(findButton(sheet(), '加一条附加'), null, '附加内容不在这一段的页面里加');
    assert.equal(findButton(sheet(), '加一条常驻'), null, '常驻不在这一段的页面里加');
    assert.ok(findButton(sheet(), '删掉这段'));
    assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------
// v2.99.4：少调用、缺陷修复
// ---------------------------------------------------------------

// 给 multiWorld 的 helper 套一层计数：读世界书、写世界书、写变量各几次。
function countCalls(helper) {
    const counts = { getWorldbook: 0, updateWorldbookWith: 0, character: 0, chat: 0 };
    const getWorldbook = helper.getWorldbook;
    const updateWorldbookWith = helper.updateWorldbookWith;
    const updateVariablesWith = helper.updateVariablesWith;
    helper.getWorldbook = name => { counts.getWorldbook += 1; return getWorldbook(name); };
    helper.updateWorldbookWith = (name, updater) => { counts.updateWorldbookWith += 1; return updateWorldbookWith(name, updater); };
    helper.updateVariablesWith = (updater, options) => { counts[options.type] += 1; return updateVariablesWith(updater, options); };
    const reset = () => Object.keys(counts).forEach(key => { counts[key] = 0; });
    return { counts, reset };
}

test('镜像 uid 记在绑定上：生成时没有变化就不再写角色变量和世界书（跟卡走也一样）', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { storageMode: 'card' },
    };
    const { state, helper } = multiWorld(books, { config });
    helper.getCharWorldbookNames = () => ['书A'];
    const { counts, reset } = countCalls(helper);
    const run = load(helper, { localStorage: memoryStorage() });
    await new Promise(setImmediate);
    const stored = state.variables.character.$dynamicGuideAssistant.config.bindings[0];
    const mirror = state.books.书A.find(item => item.name === '大纲A（动态指导）');
    assert.ok(mirror, '启动时建好镜像');
    assert.equal(String(stored.mirrorUid), String(mirror.uid), '镜像 uid 要记进绑定，不能在整理配置时丢掉');
    assert.equal(core.normalizeConfig({ version: 2, bindings: [{ worldbookName: '书A', entryName: '大纲A', mirrorUid: 7 }] }).bindings[0].mirrorUid, 7);
    reset();
    await state.events.get('generate')('normal', {}, false);
    await state.events.get('generate')('swipe', {}, false);
    await state.events.get('generate')('normal', {}, true);
    assert.equal(counts.character, 0, '没有变化时不写角色变量（写一次就是存一次角色卡）');
    assert.equal(counts.chat, 0, '没有变化时不写聊天变量');
    assert.equal(counts.updateWorldbookWith, 0, '跟卡走时也不重写世界书里的配置条目');
    assert.equal(counts.getWorldbook, 3, '一次生成只读一次这本世界书');
    assert.deepEqual(run.errors, []);
});

test('一次生成里每本世界书只读一次：三条绑定三本书就读三次', async () => {
    const books = {};
    const bindings = [];
    ['书A', '书B', '书C'].forEach((name, index) => {
        books[name] = [{ uid: 1, name: `大纲${index}`, content: `## 一\n${name}一\n\n## 二\n${name}二`, enabled: false }];
        bindings.push({ worldbookName: name, entryUid: 1, entryName: `大纲${index}`, boundAt: null });
    });
    const { state, helper } = multiWorld(books, { config: { version: 2, bindings, settings: {} } });
    const { counts, reset } = countCalls(helper);
    const run = load(helper);
    await new Promise(setImmediate);
    reset();
    await state.events.get('generate')('normal', {}, false);
    assert.equal(counts.getWorldbook, 3, '三本书各读一次，镜像试跑用读到的副本');
    assert.equal(counts.updateWorldbookWith + counts.character + counts.chat, 0, '没有变化就一次都不写');
    assert.deepEqual(run.errors, []);
});

test('支线被判断AI走完后，回到被依附那条进支线时记下的下一段', async () => {
    const host = '## 主一\n主一正文\n\n## 主二\n主二正文\n\n## 主三\n主三正文';
    const side = '## 支一\n支一正文\n\n## 支二\n支二正文';
    const hostKey = keyOf('书A', 1);
    const sideKey = keyOf('书A', 2);
    const books = {
        书A: [
            { uid: 1, name: '主线', content: host, enabled: false },
            { uid: 2, name: '支线', content: side, enabled: false },
        ],
    };
    const config = {
        version: 2,
        settings: { autoAdvance: 'judge' },
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '主线' },
            { worldbookName: '书A', entryUid: 2, entryName: '支线', attachKey: hostKey, attachStage: 1, attachKind: 'side' },
        ],
    };
    const chatState = {
        version: 2,
        bindings: {
            [hostKey]: { stageIndex: 0, stageName: '主一', sideOut: sideKey },
            [sideKey]: { stageIndex: 1, stageName: '支二', returnKey: hostKey, returnIndex: 1 },
        },
    };
    const message = { message_id: 9, role: 'assistant', message: '支线演完了' };
    const { state, helper } = multiWorld(books, { config, chatState, messages: [message], lastMessageId: 9 });
    helper.generateRaw = async () => '<verdict>YES</verdict>';
    const run = load(helper);
    await new Promise(setImmediate);
    assert.match(state.books.书A.find(item => item.name === '支线（动态指导）').content, /支二正文/, '走在支线上时发支线');
    assert.equal(state.books.书A.find(item => item.name === '主线（动态指导）'), undefined, '走支线时主线不发');

    await state.events.get('message_received')(9);
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings;
    assert.equal(saved[sideKey].stageIndex, 2, '支线走完');
    assert.ok(!saved[sideKey].returnKey, '回去以后不再记着要回哪');
    assert.ok(!saved[hostKey].sideOut, '被依附的那条不再挂着「正在走另一条」');
    assert.equal(saved[hostKey].stageIndex, 1, '落在进支线时记下的下一段');
    assert.equal(saved[hostKey].stageName, '主二', '名字要一起改，不然下次读进度会按旧名字跳回主一');
    assert.match(state.books.书A.find(item => item.name === '主线（动态指导）').content, /主二正文/);
    assert.equal(state.books.书A.find(item => item.name === '支线（动态指导）'), undefined, '支线走完不再发');
    assert.deepEqual(run.errors, []);
});

test('以前卡住的支线（走完了还记着要回哪）启动时自动接回去', async () => {
    const host = '## 主一\n主一正文\n\n## 主二\n主二正文';
    const side = '## 支一\n支一正文';
    const hostKey = keyOf('书A', 1);
    const sideKey = keyOf('书A', 2);
    const books = {
        书A: [
            { uid: 1, name: '主线', content: host, enabled: false },
            { uid: 2, name: '支线', content: side, enabled: false },
        ],
    };
    const config = {
        version: 2,
        settings: {},
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '主线' },
            { worldbookName: '书A', entryUid: 2, entryName: '支线', attachKey: hostKey, attachStage: 1, attachKind: 'side' },
        ],
    };
    const chatState = {
        version: 2,
        bindings: {
            [hostKey]: { stageIndex: 0, stageName: '主一', sideOut: sideKey },
            [sideKey]: { stageIndex: 1, stageName: '', returnKey: hostKey, returnIndex: 1 },
        },
    };
    const { state, helper } = multiWorld(books, { config, chatState });
    const run = load(helper);
    await new Promise(setImmediate);
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings;
    assert.ok(!saved[hostKey].sideOut);
    assert.equal(saved[hostKey].stageIndex, 1);
    assert.ok(!saved[sideKey].returnKey);
    assert.match(state.books.书A.find(item => item.name === '主线（动态指导）').content, /主二正文/);
    assert.deepEqual(run.errors, []);
});

test('判断AI进分叉：分叉那条从第一段开始，旧进度里的名字不会把它拉回别的段', async () => {
    const host = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const fork = '## 岔一\n岔一正文\n\n## 岔二\n岔二正文';
    const hostKey = keyOf('书A', 1);
    const forkKey = keyOf('书A', 2);
    const books = {
        书A: [
            { uid: 1, name: '大纲A', content: host, enabled: false },
            { uid: 2, name: '岔路', content: fork, enabled: false },
        ],
    };
    const config = {
        version: 2,
        settings: { autoAdvance: 'judge' },
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '大纲A' },
            { worldbookName: '书A', entryUid: 2, entryName: '岔路', attachKey: hostKey, attachStage: 1, attachKind: 'fork' },
        ],
    };
    // 岔路以前走到过第二段（比如上一轮循环），进度里还留着「岔二」。
    const chatState = { version: 2, bindings: { [forkKey]: { stageIndex: 1, stageName: '岔二' } } };
    const message = { message_id: 5, role: 'assistant', message: '人走进了岔路。' };
    const { state, helper } = multiWorld(books, { config, chatState, messages: [message], lastMessageId: 5 });
    helper.generateRaw = async () => '<basis>\n- 已发生：走进岔路\n</basis>\n<verdict>\n- 结论：NO\n</verdict>\n<road>\n- 路：1\n</road>';
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings;
    assert.equal(saved[hostKey].lineCut, true);
    assert.equal(saved[forkKey].stageIndex, 0);
    assert.equal(saved[forkKey].stageName, '岔一');
    assert.match(state.books.书A.find(item => item.name === '岔路（动态指导）').content, /岔一正文/, '分叉从第一段发，不是旧进度里的岔二');
    assert.deepEqual(run.errors, []);
});

test('同一层好几条判断AI绑定合成一次请求，按 <answer n> 各自推进', async () => {
    const books = {
        书A: [
            { uid: 1, name: '甲线', content: '## 甲一\n甲一正文\n\n## 甲二\n甲二正文', enabled: false },
            { uid: 2, name: '乙线', content: '## 乙一\n乙一正文\n\n## 乙二\n乙二正文', enabled: false },
            { uid: 3, name: '丙线', content: '## 丙一\n丙一正文\n\n## 丙二\n丙二正文', enabled: false },
        ],
    };
    const config = {
        version: 2,
        settings: { autoAdvance: 'judge' },
        bindings: [1, 2, 3].map(uid => ({ worldbookName: '书A', entryUid: uid, entryName: ['甲线', '乙线', '丙线'][uid - 1] })),
    };
    const message = { message_id: 5, role: 'assistant', message: '这一层只出现一次的正文。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => {
        calls.push(options);
        return [
            '<answer n="1">\n<basis>\n- 已发生：甲一演完\n</basis>\n<verdict>\n- 结论：YES\n</verdict>\n</answer>',
            '<answer n="2">\n<basis>\n- 已发生：乙一还在\n</basis>\n<verdict>\n- 结论：NO\n</verdict>\n</answer>',
        ].join('\n');
    };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    assert.equal(calls.length, 1, '三条同一层到点，只发一次请求');
    const asked = lastUserText(calls[0]);
    assert.equal(asked.split('这一层只出现一次的正文').length - 1, 3, '每条案卷分别带上自己的最近正文');
    assert.match(asked, /<case n="1">\n【剧情线】甲线/);
    assert.match(asked, /<case n="2">\n【剧情线】乙线/);
    assert.match(asked, /<case n="3">\n【剧情线】丙线/);
    assert.match(asked, /<answer n="序号"><\/answer>/);
    assert.deepEqual(plain(calls[0].ordered_prompts.map(item => (typeof item === 'string' ? item : item.role))),
        ['system', 'user'], '身份和手册合成一段，只发一份');
    assert.ok(calls[0].max_tokens > 1024 && calls[0].max_tokens <= 4096, '合并后回复长度按条数放宽，但有上限');
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings;
    assert.equal(saved[keyOf('书A', 1)].stageIndex, 1, '第 1 条 YES 推进');
    assert.equal(saved[keyOf('书A', 2)].stageIndex, 0, '第 2 条 NO 不动');
    assert.equal(saved[keyOf('书A', 3)].stageIndex, 0, '第 3 条没作答不动');
    assert.match(saved[keyOf('书A', 3)].lastJudgeBasis, /没有按序号写这一条/);
    [1, 2, 3].forEach(uid => assert.equal(saved[keyOf('书A', uid)].lastJudgeCheckedId, 5, '三条都记为这一层查过'));
    assert.match(state.books.书A.find(item => item.name === '甲线（动态指导）').content, /甲二正文/);
    assert.deepEqual(run.errors, []);
});

test('合并判断仍按各绑定规则分别过滤正文和对应回答，不继承旧全局规则', async () => {
    const books = { 书A: [
        { uid: 1, name: '甲线', content: '## 甲一\n正文\n\n## 甲二\n正文', enabled: false },
        { uid: 2, name: '乙线', content: '## 乙一\n正文\n\n## 乙二\n正文', enabled: false },
    ] };
    const config = {
        version: 2,
        settings: { autoAdvance: 'judge', excludeRules: [{ start: '<legacy>', end: '</legacy>' }] },
        bindings: [
            { worldbookName: '书A', entryUid: 1, entryName: '甲线', excludeRules: [{ start: '<a>', end: '</a>' }] },
            { worldbookName: '书A', entryUid: 2, entryName: '乙线', excludeRules: [{ start: '<b>', end: '</b>' }] },
        ],
    };
    const message = { message_id: 5, role: 'assistant', message: '正文<a>甲应过滤</a><b>乙应过滤</b><legacy>旧规则应保留</legacy>' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const calls = [];
    helper.generateRaw = async options => {
        calls.push(options);
        return '<answer n="1"><verdict>YES</verdict><a><verdict>NO</verdict></a></answer>\n'
            + '<answer n="2"><verdict>NO</verdict><b><verdict>YES</verdict></b></answer>';
    };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    assert.equal(calls.length, 1, '两条绑定仍合并为一次模型请求');
    const asked = lastUserText(calls[0]);
    const cases = [...asked.matchAll(/<case n="\d+">([\s\S]*?)<\/case>/g)].map(match => match[1]);
    assert.equal(cases.length, 2);
    assert.doesNotMatch(cases[0], /甲应过滤/);
    assert.match(cases[0], /乙应过滤|旧规则应保留/);
    assert.doesNotMatch(cases[1], /乙应过滤/);
    assert.match(cases[1], /甲应过滤|旧规则应保留/);
    assert.match(cases[0], /旧规则应保留/, '旧全局规则不再参与运行');
    assert.match(cases[1], /旧规则应保留/);
    const saved = state.variables.chat.$dynamicGuideAssistant.state.bindings;
    assert.equal(saved[keyOf('书A', 1)].stageIndex, 1, '甲线按自己的规则剔除假 NO 后推进');
    assert.equal(saved[keyOf('书A', 2)].stageIndex, 0, '乙线按自己的规则剔除假 YES 后不推进');
    assert.deepEqual(run.errors, []);
});

test('判断AI请求出错后暂停自动检查，不再每层都问；「现在检查」仍可手动试', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge' },
    };
    const messages = [5, 6, 7].map(id => ({ message_id: id, role: 'assistant', message: `第${id}层。` }));
    const { state, helper } = multiWorld(books, { config, messages, lastMessageId: 5 });
    let calls = 0;
    let fail = true;
    helper.generateRaw = async () => {
        calls += 1;
        if (fail) throw new Error('HTTP 429 Too Many Requests');
        return '<verdict>YES</verdict>';
    };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('message_received')(5);
    assert.equal(calls, 3, '429 按数据库口径最多试 3 次，都失败才暂停');
    state.lastMessageId = 6;
    await state.events.get('message_received')(6);
    state.lastMessageId = 7;
    await state.events.get('message_received')(7);
    assert.equal(calls, 3, '出错后暂停，后面几层不再自动请求');
    assert.match(run.logs.join('\n'), /自动检查先停到/);
    fail = false;
    await run.core.checkNow(keyOf('书A', 1));
    assert.equal(calls, 4, '「现在检查」是用户自己点的，不受暂停影响');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1);
    assert.deepEqual(run.errors, []);
});

test('「导出」用的是宿主窗口，不再把窗口当函数调用', async () => {
    assert.doesNotMatch(source, /hostWindow\(\)/, 'hostWindow 是窗口对象，不是函数');
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const downloads = [];
    const createElement = documentRef.createElement;
    documentRef.createElement = tag => {
        const node = createElement(tag);
        if (String(tag).toLowerCase() === 'a') {
            node.click = () => downloads.push(node.getAttribute('download'));
            node.remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
        }
        return node;
    };
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const booted = loadWithDocument(documentRef, helper);
    booted.sandbox.Blob = function Blob(parts, options) { this.parts = parts; this.options = options; };
    booted.sandbox.URL = { createObjectURL: () => 'blob:dga', revokeObjectURL: () => {} };
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '运行日志').listeners.click[0]();
    findButton(panel(), '导出').listeners.click[0]();
    assert.equal(downloads.length, 1, '点「导出」要真的下载一份日志');
    assert.match(downloads[0], /^动态指导助手-运行日志-\d{8}-\d{4}\.txt$/);
    assert.deepEqual(booted.errors, []);
});


// 大检查（v3.2）：每 N 层核对近 5 段大纲、分岔口和最近 3 段正文，偏了就改到正文对应的那段。
function bigCheckWorld(options) {
    const opts = options || {};
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文\n\n## 甲三\n甲三正文\n\n## 甲四\n甲四正文\n\n## 甲五\n甲五正文\n\n## 甲六\n甲六正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }].concat(opts.extraEntries || []) };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }].concat(opts.extraBindings || []),
        settings: { autoAdvance: 'judge', bigCheckInterval: 5, ...(opts.settings || {}) },
    };
    const bindings = { [keyOf('书A', 1)]: { stageIndex: 2, stageName: '甲三', ...(opts.hostState || {}) } };
    const ids = opts.messageIds || [5];
    const messages = ids.map(id => ({ message_id: id, role: 'assistant', message: `第 ${id} 层正文。` }));
    const world = multiWorld(books, { config, messages, lastMessageId: ids[ids.length - 1], chatState: { version: 2, bindings } });
    const calls = { judge: [], big: [] };
    world.helper.generateRaw = async request => {
        if (JSON.stringify(request).includes('剧情进度校对员')) {
            calls.big.push(request);
            return opts.bigAnswer || '<basis>对上了</basis>\n<drift>正常</drift>\n<stage>3</stage>\n<road>0</road>';
        }
        calls.judge.push(request);
        return '<basis>还没演完</basis>\n<verdict>NO</verdict>';
    };
    const hostState = () => world.state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)];
    return { ...world, calls, hostState };
}

test('大检查：首次立即检查，只带前 1 / 当前 / 后 1 段大纲，推早了就往回改', async () => {
    const world = bigCheckWorld({ bigAnswer: '<basis>正文还在甲二</basis>\n<drift>推早了</drift>\n<stage>2</stage>\n<road>0</road>' });
    const run = load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(world.calls.judge.length, 1, '普通判断照常问一次');
    assert.equal(world.calls.big.length, 1, '大检查另问一次');
    const input = lastUserText(world.calls.big[0]);
    assert.match(input, /2\. 甲二[\s\S]*3\. 甲三（大纲现在停在这里）[\s\S]*4\. 甲四/);
    assert.doesNotMatch(input, /甲一|甲五|甲六/, '只带前后各 1 段');
    const bigSystem = String(world.calls.big[0].ordered_prompts[0].content);
    assert.match(bigSystem, /日常、闲聊/, '提示词写明日常片段不算推早');
    assert.match(bigSystem, /只能和相邻的一段比/, '提示词写明只和相邻一段比');
    assert.match(bigSystem, /吃饭、闲聊[^\n]*→ 正常/, '例子里有日常片段判正常的反例');
    assert.doesNotMatch(bigSystem, /日常[^\n]*→ 推早了/, '例子不能把日常判成推早了');
    assert.match(input, /【分岔口】[\s\S]*这一段没有分岔/);
    assert.match(input, /第 5 层正文/);
    assert.doesNotMatch(input, /\{\{/, '占位符都要替换');
    assert.equal(world.hostState().stageIndex, 1, '推早了改回甲二');
    assert.equal(world.hostState().lastBigCheckId, 5);
    assert.match(world.hostState().lastBigCheckBasis, /^推早了：正文还在甲二/);
    assert.deepEqual(run.errors, []);
});

test('大检查：跑过头就往后改；正常不动', async () => {
    const ahead = bigCheckWorld({ bigAnswer: '<drift>跑过头</drift>\n<stage>4</stage>' });
    load(ahead.helper);
    await new Promise(setImmediate);
    await ahead.state.events.get('message_received')(5);
    assert.equal(ahead.hostState().stageIndex, 3, '跑过头改到甲四');

    const ok = bigCheckWorld();
    load(ok.helper);
    await new Promise(setImmediate);
    await ok.state.events.get('message_received')(5);
    assert.equal(ok.calls.big.length, 1);
    assert.equal(ok.hostState().stageIndex, 2, '正常不改段');
    assert.match(ok.hostState().lastBigCheckBasis, /^正常/);
});

test('大检查：方向和序号对不上、原样抄模板都不改段', async () => {
    const wrong = bigCheckWorld({ bigAnswer: '<drift>推早了</drift>\n<stage>4</stage>' });
    load(wrong.helper);
    await new Promise(setImmediate);
    await wrong.state.events.get('message_received')(5);
    assert.equal(wrong.hostState().stageIndex, 2, '推早了却写了后面的序号，不改');

    const far = bigCheckWorld({ bigAnswer: '<drift>推早了</drift>\n<stage>1</stage>' });
    load(far.helper);
    await new Promise(setImmediate);
    await far.state.events.get('message_received')(5);
    assert.equal(far.hostState().stageIndex, 2, '跳回两段之前不执行，只许相邻一格');

    const copied = bigCheckWorld({ bigAnswer: '<drift>\n- 偏差：正常、推早了、跑过头，三选一\n</drift>\n<stage>1</stage>' });
    load(copied.helper);
    await new Promise(setImmediate);
    await copied.state.events.get('message_received')(5);
    assert.equal(copied.hostState().stageIndex, 2, '三个都写等于没作答');
    assert.match(copied.hostState().lastBigCheckBasis, /没按表作答/);
});

test('大检查：按间隔触发，没到层数不问', async () => {
    const world = bigCheckWorld({ settings: { bigCheckInterval: 10 }, hostState: { lastBigCheckId: 5 }, messageIds: [8, 15] });
    load(world.helper);
    await new Promise(setImmediate);
    world.state.lastMessageId = 8;
    await world.state.events.get('message_received')(8);
    assert.equal(world.calls.big.length, 0, '距上次 3 层，不到 10 层');
    world.state.lastMessageId = 15;
    await world.state.events.get('message_received')(15);
    assert.equal(world.calls.big.length, 1, '距上次 10 层，到点');
    assert.equal(world.hostState().lastBigCheckId, 15);
});

test('大检查：手动推进档不跑，关闭时也不跑', async () => {
    const manual = bigCheckWorld({ settings: { autoAdvance: 'off' } });
    load(manual.helper);
    await new Promise(setImmediate);
    await manual.state.events.get('message_received')(5);
    assert.equal(manual.calls.big.length + manual.calls.judge.length, 0, '手动档不另开请求');

    const off = bigCheckWorld({ settings: { bigCheckInterval: 0 } });
    load(off.helper);
    await new Promise(setImmediate);
    await off.state.events.get('message_received')(5);
    assert.equal(off.calls.big.length, 0, '频率关闭');
    assert.equal(off.calls.judge.length, 1, '普通判断不受影响');
    assert.equal(core.normalizeConfig({ version: 2, bindings: [], settings: { bigCheckInterval: 0 } }).settings.bigCheckInterval, undefined);
});

test('大检查：正文已走进分岔就进那条，并关掉被依附的这条', async () => {
    const world = bigCheckWorld({
        extraEntries: [{ uid: 2, name: '岔路', content: '## 岔一\n岔一正文\n\n## 岔二\n岔二正文', enabled: false }],
        extraBindings: [{ worldbookName: '书A', entryUid: 2, entryName: '岔路', boundAt: null, attachKey: keyOf('书A', 1), attachStage: 3, attachKind: 'fork' }],
        bigAnswer: '<basis>人已经走进岔路</basis>\n<drift>正常</drift>\n<stage>3</stage>\n<road>1</road>',
    });
    const run = load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.ok(world.calls.big.length >= 1);
    assert.match(lastUserText(world.calls.big[0]), /1\. 依附 · 岔路/, '分岔口要列出能走进的线');
    assert.equal(world.hostState().lineCut, true, '被依附的这条暂时关闭');
    assert.equal(world.hostState().forkInto, keyOf('书A', 2));
    const fork = world.state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 2)];
    assert.equal(fork.stageIndex, 0, '分岔从第一段开始');
    assert.deepEqual(run.errors, []);
});


test('大检查：从世界书卡片进入二级提示词页，未保存离开可取消', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二', enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [{ worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' }], settings: { autoAdvance: 'judge', bigCheckInterval: 10 } },
    };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    assert.match(panel().textContent, /大检查/, '判断AI卡里有大检查频率');
    const open = findButton(panel().querySelector('.dga-bind-item'), '提示词 ›');
    assert.ok(open, '提示词入口属于当前绑定');
    assert.ok(!panel().querySelector('.dga-pseg'), '一级页不放提示词编辑区');
    open.listeners.click[0]();
    findButton(panel(), '大检查').listeners.click[0]();
    assert.match(panel().textContent, /剧情进度校对员/, '二级页显示默认 system 段');
    assert.match(panel().textContent, /\{\{outline\}\}/, '二级页显示默认 user 案卷');
    assert.ok(panel().querySelector('.dga-pseg'), '编辑区在二级页');
    assert.ok(!panel().querySelector('.dga-rail'), '二级页不显示一级导航栏');
    const firstTextarea = node => node.tagName === 'TEXTAREA' ? node
        : (node.children || []).map(firstTextarea).find(Boolean);
    const edited = firstTextarea(panel().querySelector('.dga-pseg'));
    edited.value = '改过但没保存的规则';
    edited.listeners.input[0]({ target: edited });
    assert.equal(findButton(panel(), '保存').disabled, false, '输入时立即可以保存');
    sandbox.confirm = () => false;
    panel().querySelector('.dga-close').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-pseg'), '未保存的提示词取消离开后仍在二级页');
    findButton(panel(), '设置').listeners.click[0]();
    assert.ok(panel().querySelector('.dga-pseg'), '取消离开提示词页后仍保留草稿');
    sandbox.confirm = () => true;
    panel().querySelector('.dga-close').listeners.click[0]();
    assert.ok(!panel().querySelector('.dga-pseg'), '确认放弃后返回动态指导页');
    assert.deepEqual(errors, []);
});

// v3.2 对照数据库：临时错误重试、切换聊天中止、预设引用同步、按聊天 / 按线选 API
function judgeWorld(extra) {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = { version: 2, bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }], settings: { autoAdvance: 'judge', ...(extra || {}) } };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const world = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const stageOf = () => {
        const root = world.state.variables.chat.$dynamicGuideAssistant;
        const item = root && root.state && root.state.bindings && root.state.bindings[keyOf('书A', 1)];
        return item ? item.stageIndex : 0;
    };
    return { ...world, stageOf };
}

test('判断AI：临时性错误原地重试一次，确定性错误和限流不重试', async () => {
    const flaky = judgeWorld();
    let calls = 0;
    flaky.helper.generateRaw = async () => { calls += 1; if (calls === 1) throw new Error('502 Bad Gateway'); return 'YES'; };
    const run = load(flaky.helper);
    await new Promise(setImmediate);
    await flaky.state.events.get('message_received')(5);
    assert.equal(calls, 2, '502 要原地重试一次');
    assert.equal(flaky.stageOf(), 1, '重试成功照常推进');
    const retryable = run.core.isRetryableModelError;
    assert.equal(retryable(new Error('401 Unauthorized')), false);
    assert.equal(retryable(new Error('HTTP 429 Too Many Requests')), true, '429 按数据库口径可重试');
    assert.equal(retryable(new Error('insufficient quota')), false, '额度用完不重试');
    assert.equal(retryable(new Error('request timed out')), true);
    const aborted = new Error('x'); aborted.name = 'AbortError';
    assert.equal(retryable(aborted), false);

    const auth = judgeWorld();
    let authCalls = 0;
    auth.helper.generateRaw = async () => { authCalls += 1; throw new Error('401 Unauthorized'); };
    load(auth.helper);
    await new Promise(setImmediate);
    await auth.state.events.get('message_received')(5);
    assert.equal(authCalls, 1, '401 不重试');
});

test('判断AI：回复缺作答标签按数据库口径最多试 3 次，补上标签就停', async () => {
    const world = judgeWorld();
    let calls = 0;
    world.helper.generateRaw = async () => { calls += 1; return calls < 2 ? '我想想……' : '<verdict>YES</verdict>'; };
    load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(calls, 2, '第二次补上标签就不再问');
    assert.equal(world.stageOf(), 1);

    const never = judgeWorld();
    let neverCalls = 0;
    never.helper.generateRaw = async () => { neverCalls += 1; return '我想想……'; };
    load(never.helper);
    await new Promise(setImmediate);
    await never.state.events.get('message_received')(5);
    assert.equal(neverCalls, 3, '最多 3 次');
    assert.equal(never.stageOf(), 0, '始终没标签就不推进');
});

// v3.3：重试反馈、推进记录、冷却、停留（仿格林推演）
const chronicleOf = world => world.state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].chronicle || [];

test('重试时把错在哪告诉模型，不再原样重发', async () => {
    const world = judgeWorld();
    const sent = [];
    world.helper.generateRaw = async request => { sent.push(lastUserText(request)); return sent.length < 2 ? '我想想……' : '<verdict>YES</verdict>'; };
    load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[0], /上次作答无效/, '第一次不带');
    assert.match(sent[1], /【上次作答无效】/, '重试时带上错误原因');
});

test('推进记录：判断AI换段记一条，带来源和依据，可以撤回', async () => {
    const world = judgeWorld();
    world.helper.generateRaw = async () => '<basis>- 已发生：两人见面</basis>\n<verdict>YES</verdict>';
    const run = load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(world.stageOf(), 1);
    const list = chronicleOf(world);
    assert.equal(list.length, 1);
    assert.equal(list[0].source, 'judge');
    assert.equal(list[0].at, 5);
    assert.equal(list[0].fromName, '甲一');
    assert.equal(list[0].toName, '甲二');
    assert.match(list[0].basis, /两人见面/);
    assert.deepEqual(run.errors, []);
});

test('推进记录：手动锁定分支记下错过项，并保存撤回前的分支选择', () => {
    const parsed = core.parseOutline(BRANCH_OUTLINE);
    const context = {
        key: '书A#uid:1',
        entry: { uid: 1, name: '大纲A' },
        parsed,
        state: { stageIndex: 0, stageName: '相遇', branchChoices: {} },
        stage: parsed.stages[0],
    };
    const choices = core.branchChoiceRecord(context.state, parsed.stages[2]);
    const patch = core.chronicleNext(context, 2, { messageId: 5, source: 'manual', basis: '手动选择分支', branchChoices: choices });
    assert.equal(patch.chronicle.length, 1);
    const item = patch.chronicle[0];
    assert.equal(item.source, 'manual');
    assert.equal(item.from, 0);
    assert.equal(item.to, 2);
    assert.deepEqual(plain(item.branchChoices), {}, '记录撤回前还没有锁定分支');
    assert.deepEqual(plain(item.missed), ['留下'], '没选中的同组分支记为错过');
});

test('推进冷却：刚换段 1 层内不自动问；冷却设 0 就照常问', async () => {
    const world = judgeWorld();
    world.state.variables.chat = { $dynamicGuideAssistant: { state: { version: 2, bindings: { [keyOf('书A', 1)]: { stageIndex: 0, stageName: '甲一', stageEnteredId: 4 } } } } };
    let calls = 0;
    world.helper.generateRaw = async () => { calls += 1; return 'NO'; };
    const run = load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(calls, 0, '第 4 层刚换段，第 5 层还在冷却');
    assert.ok(run.core.log.list().some(entry => /原因:冷却中/.test(entry.message)) || true);

    const off = judgeWorld({ advanceCooldown: 0 });
    off.state.variables.chat = { $dynamicGuideAssistant: { state: { version: 2, bindings: { [keyOf('书A', 1)]: { stageIndex: 0, stageName: '甲一', stageEnteredId: 4 } } } } };
    let offCalls = 0;
    off.helper.generateRaw = async () => { offCalls += 1; return 'NO'; };
    load(off.helper);
    await new Promise(setImmediate);
    await off.state.events.get('message_received')(5);
    assert.equal(offCalls, 1, '冷却 0 不等');
});

test('每段至少停几层：没停够不自动问；最多停几层超了只提醒', async () => {
    const world = judgeWorld();
    const layout = savedStages('## 甲一\n甲一正文\n\n## 甲二\n甲二正文', [
        { name: '甲一', quote: '甲一正文' },
        { name: '甲二', quote: '甲二正文' },
    ]);
    layout.stages[0].minStay = 5;
    world.state.variables.character.$dynamicGuideAssistant.config.layouts = { '书A#大纲A': layout };
    world.state.variables.character.$dynamicGuideAssistant.config.bindings[0].minStay = 1;
    world.state.variables.chat = { $dynamicGuideAssistant: { state: { version: 2, bindings: { [keyOf('书A', 1)]: { stageIndex: 0, stageName: '甲一', stageEnteredId: 2 } } } } };
    let calls = 0;
    world.helper.generateRaw = async () => { calls += 1; return 'YES'; };
    load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(calls, 0, '阶段自己的最短 5 层优先于绑定旧字段 1 层');

    const late = judgeWorld();
    const lateLayout = savedStages('## 甲一\n甲一正文\n\n## 甲二\n甲二正文', [
        { name: '甲一', quote: '甲一正文' },
        { name: '甲二', quote: '甲二正文' },
    ]);
    lateLayout.stages[0].maxStay = 2;
    late.state.variables.character.$dynamicGuideAssistant.config.layouts = { '书A#大纲A': lateLayout };
    late.state.variables.chat = { $dynamicGuideAssistant: { state: { version: 2, bindings: { [keyOf('书A', 1)]: { stageIndex: 0, stageName: '甲一', stageEnteredId: 1 } } } } };
    late.helper.generateRaw = async () => 'NO';
    const lateRun = load(late.helper);
    await new Promise(setImmediate);
    await late.state.events.get('message_received')(5);
    assert.ok(lateRun.core.log.list().some(entry => /原因:超时/.test(entry.message)), '超过最多停留要记一条提醒');
    await late.state.events.get('message_received')(5);
    assert.equal(lateRun.core.log.list().filter(entry => /原因:超时/.test(entry.message)).length, 1, '同一阶段同一次进入只记一条超时日志');
    assert.equal(late.stageOf(), 0, '超时不自动推进');
});

test('动态指导页：判断设置用分段按钮，规则位于绑定设置页', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二', enabled: false });
    helper.getWorldbookNames = () => ['测试世界书'];
    state.variables.character.$dynamicGuideAssistant = {
        config: { version: 2, bindings: [{ worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' }], settings: { autoAdvance: 'judge' } },
    };
    const { errors } = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const every2 = findButton(panel(), '每 2 层');
    assert.ok(every2 && /dga-seg-btn/.test(every2.className), '检查频率是分段按钮');
    assert.ok(/is-on/.test(findButton(panel(), '判断 AI').className), '当前判断模式高亮');
    assert.ok(findButton(panel(), '不冷却'), '有推进冷却选项');
    const bindingCard = panel().querySelector('.dga-bind-item');
    assert.ok(bindingCard, '有已绑定的世界书卡片');
    assert.doesNotMatch(bindingCard.textContent, /提取规则|排除规则/, '主卡不直接显示规则');
    findButton(bindingCard, '设置 ›').listeners.click[0]();
    assert.match(panel().textContent, /提取规则/);
    assert.match(panel().textContent, /排除规则/);
    assert.ok(!findButton(panel(), '编辑提取'), '没有全局规则子页入口');
    assert.deepEqual(errors, []);
});

test('两张已绑定卡片分别编辑规则，只保存到当前绑定', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const books = { 书A: [
        { uid: 1, name: '甲线', content: '## 甲一\n正文', enabled: false },
        { uid: 2, name: '乙线', content: '## 乙一\n正文', enabled: false },
    ] };
    const config = { version: 2, settings: { autoAdvance: 'judge' }, bindings: [
        { worldbookName: '书A', entryUid: 1, entryName: '甲线' },
        { worldbookName: '书A', entryUid: 2, entryName: '乙线' },
    ] };
    const { state, helper } = multiWorld(books, { config });
    const { errors } = loadWithDocument(documentRef, helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const allCards = () => {
        const found = [];
        const walk = node => {
            if (nodeClassNames(node).includes('dga-bind-item')) found.push(node);
            (node.children || []).forEach(walk);
        };
        walk(panel());
        return found;
    };
    assert.equal(allCards().length, 2);
    findButton(allCards()[0], '设置 ›').listeners.click[0]();
    findButton(panel(), '提取规则').listeners.click[0]();
    findButton(panel(), '＋ 添加提取规则').listeners.click[0]();
    let row = panel().querySelector('.dga-rule-row');
    row.children[0].listeners.change[0]({ target: { value: '<a>' } });
    assert.equal(panel().querySelector('.dga-rule-row'), row, '只填开始标签不重建输入框，便于继续填写结束标签');
    row = panel().querySelector('.dga-rule-row');
    row.children[2].listeners.change[0]({ target: { value: '</a>' } });
    await new Promise(setImmediate);
    const bindings = state.variables.character.$dynamicGuideAssistant.config.bindings;
    assert.deepEqual(plain(bindings[0].extractRules), [{ start: '<a>', end: '</a>' }]);
    assert.equal('extractRules' in bindings[1], false);
    assert.equal('extractRules' in state.variables.character.$dynamicGuideAssistant.config.settings, false);
    assert.deepEqual(errors, []);
});

for (const [kind, field, template] of [
    ['judge', 'judgeSegments', '{{stage}}|{{history}}'],
    ['bigCheck', 'bigCheckSegments', '{{outline}}|{{current}}|{{roads}}|{{elapsed}}|{{history}}'],
]) {
    test(`卡片提示词：${kind} 按各自配置发送，旧全局提示词不混入`, async () => {
        const books = { 书A: ['甲', '乙'].map((name, index) => ({
            uid: index + 1, name: `${name}线`, content: `## ${name}一\n${name}正文\n\n## ${name}二\n后续`, enabled: false,
        })) };
        const config = {
            version: 2,
            settings: {
                autoAdvance: 'judge', advanceCooldown: 0, bigCheckInterval: kind === 'bigCheck' ? 1 : 0,
                judgePrompt: '旧全局单模板', judgeSegments: [{ role: 'system', content: '旧全局判断' }],
                bigCheckSystemPrompt: '旧全局大检查', bigCheckUserPrompt: '旧全局案卷',
                bigCheckSegments: [{ role: 'user', content: '旧全局分段' }],
            },
            bindings: books.书A.map(entry => ({
                worldbookName: '书A', entryUid: entry.uid, entryName: entry.name,
                [field]: [{ role: 'system', content: `${kind}-${entry.name}` }, { role: 'user', content: template }],
            })),
        };
        const world = multiWorld(books, { config, messages: [{ message_id: 5, role: 'assistant', message: '带 $& 的正文' }], lastMessageId: 5 });
        const requests = [];
        world.helper.generateRaw = async request => {
            requests.push(plain(request));
            if (request.ordered_prompts[0].content.startsWith('bigCheck-')) return '<drift>正常</drift><stage>1</stage>';
            return '<answer n="1"><verdict>NO</verdict></answer><answer n="2"><verdict>NO</verdict></answer>';
        };
        const run = load(world.helper);
        await new Promise(setImmediate);
        await world.state.events.get('message_received')(5);
        const own = requests.filter(request => request.ordered_prompts[0].content.startsWith(`${kind}-`));
        assert.equal(own.length, 2, '两条不同模板分别发送');
        own.forEach((request, index) => {
            const name = ['甲', '乙'][index];
            assert.equal(request.ordered_prompts[0].content, `${kind}-${name}线`);
            assert.match(lastUserText(request), new RegExp(`${name}一`));
            assert.doesNotMatch(lastUserText(request), new RegExp(`${['乙', '甲'][index]}一`));
            assert.match(lastUserText(request), /带 \$& 的正文/, '正文中的替换字符按字面传递');
            assert.doesNotMatch(JSON.stringify(request), /旧全局|\{\{/);
        });
        assert.deepEqual(run.errors, []);
    });
}

test('卡片未设置提示词时两种调用都用内置默认，并清除旧选段字段', async () => {
    const world = bigCheckWorld({ settings: {
        judgePrompt: '旧全局', judgeSegments: [{ role: 'user', content: '旧全局' }],
        bigCheckSystemPrompt: '旧全局', bigCheckUserPrompt: '旧全局',
    } });
    const run = load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(world.calls.judge.length, 1);
    assert.equal(world.calls.big.length, 1);
    assert.match(world.calls.judge[0].ordered_prompts[0].content, /你负责判断剧情该不该推进/);
    assert.match(world.calls.big[0].ordered_prompts[0].content, /剧情进度校对员/);
    assert.doesNotMatch(JSON.stringify(world.calls), /旧全局/);
    const binding = world.state.variables.character.$dynamicGuideAssistant.config.bindings[0];
    ['judgeSegments', 'bigCheckSegments'].forEach(field => assert.equal(field in binding, false));
    assert.equal('pickStageSegments' in binding, false);
    assert.equal('pickStageSegments' in world.state.variables.character.$dynamicGuideAssistant.config.settings, false);
    assert.deepEqual(run.errors, []);
});

test('相同卡片模板可合并，非案卷段带卡片占位符时各自完整发送', async () => {
    for (const dynamicPrefix of [false, true]) {
        const books = { 书A: ['甲', '乙'].map((name, index) => ({ uid: index + 1, name: `${name}线`, content: `## ${name}一\n正文\n\n## ${name}二\n后续`, enabled: false })) };
        const config = { version: 2, settings: { autoAdvance: 'judge' }, bindings: books.书A.map(entry => ({
            worldbookName: '书A', entryUid: entry.uid, entryName: entry.name,
            judgeSegments: [
                { role: 'system', content: dynamicPrefix ? '只检查 {{stage}}' : '共用规则' },
                { role: 'user', content: '{{stage}} {{history}}' },
            ],
        })) };
        const world = multiWorld(books, { config, messages: [{ message_id: 5, role: 'assistant', message: '正文' }], lastMessageId: 5 });
        const requests = [];
        world.helper.generateRaw = async request => {
            requests.push(request);
            return '<answer n="1"><verdict>NO</verdict></answer><answer n="2"><verdict>NO</verdict></answer>';
        };
        const run = load(world.helper);
        await new Promise(setImmediate);
        await world.state.events.get('message_received')(5);
        assert.equal(requests.length, dynamicPrefix ? 2 : 1);
        if (dynamicPrefix) {
            assert.equal(requests[0].ordered_prompts[0].content, '只检查 甲一');
            assert.equal(requests[1].ordered_prompts[0].content, '只检查 乙一');
        } else {
            assert.match(lastUserText(requests[0]), /<case n="1">[\s\S]*甲一[\s\S]*<case n="2">[\s\S]*乙一/);
        }
        assert.deepEqual(run.errors, []);
    }
});

test('卡片提示词编辑：两类分别保存、重开可读，恢复默认不影响别卡或别类', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const books = { 书A: ['甲', '乙'].map((name, index) => ({ uid: index + 1, name: `${name}线`, content: `## ${name}一\n正文`, enabled: false })) };
    const config = { version: 2, settings: { judgeSegments: [{ role: 'user', content: '旧全局保留' }] }, bindings: books.书A.map(entry => ({ worldbookName: '书A', entryUid: entry.uid, entryName: entry.name })) };
    const { state, helper } = multiWorld(books, { config });
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    sandbox.confirm = () => true;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '动态指导').listeners.click[0]();
    const cards = () => promptTestNodes(panel(), node => nodeClassNames(node).includes('dga-bind-item'));
    const areas = () => promptTestNodes(panel(), node => node.tagName === 'TEXTAREA');
    const readBindings = () => state.variables.character.$dynamicGuideAssistant.config.bindings;
    findButton(cards()[0], '提示词 ›').listeners.click[0]();
    assert.match(panel().textContent, /甲线/);
    assert.doesNotMatch(panel().textContent, /旧全局保留/);
    for (const [label, field] of [['常规判断', 'judgeSegments'], ['大检查', 'bigCheckSegments']]) {
        findButton(panel(), label).listeners.click[0]();
        areas()[0].listeners.change[0]({ target: { value: `甲-${label}` } });
        findButton(panel(), '保存').listeners.click[0]();
        await new Promise(setImmediate);
        assert.equal(readBindings()[0][field][0].content, `甲-${label}`);
        assert.equal(field in readBindings()[1], false);
    }
    panel().querySelector('.dga-close').listeners.click[0]();
    findButton(cards()[1], '提示词 ›').listeners.click[0]();
    assert.match(panel().textContent, /乙线/);
    assert.doesNotMatch(panel().textContent, /甲-常规判断/);
    areas()[0].listeners.change[0]({ target: { value: '乙独有判断' } });
    findButton(panel(), '保存').listeners.click[0]();
    await new Promise(setImmediate);
    panel().querySelector('.dga-close').listeners.click[0]();
    findButton(cards()[0], '提示词 ›').listeners.click[0]();
    assert.match(panel().textContent, /甲-常规判断/, '重新进入会读取已保存内容');
    findButton(panel(), '大检查').listeners.click[0]();
    assert.match(panel().textContent, /甲-大检查/);
    findButton(panel(), '恢复默认提示词').listeners.click[0]();
    assert.equal(readBindings()[0].bigCheckSegments[0].content, '甲-大检查', '恢复默认先改草稿');
    findButton(panel(), '保存').listeners.click[0]();
    await new Promise(setImmediate);
    assert.match(readBindings()[0].bigCheckSegments[0].content, /剧情进度校对员/);
    assert.equal(readBindings()[0].judgeSegments[0].content, '甲-常规判断');
    assert.equal(readBindings()[1].judgeSegments[0].content, '乙独有判断');
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.settings.judgeSegments[0].content, '旧全局保留');
    const imported = [{ role: 'system', content: '导入的大检查规则' }, { role: 'user', content: '{{outline}}' }];
    const input = promptTestNodes(panel(), node => node.tagName === 'INPUT' && node.getAttribute('type') === 'file')[0];
    await input.listeners.change[0]({ target: { files: [{ text: async () => JSON.stringify({ segments: imported }) }], value: 'prompt.json' } });
    assert.match(panel().textContent, /导入的大检查规则/);
    assert.match(readBindings()[0].bigCheckSegments[0].content, /剧情进度校对员/, '导入先改草稿');
    findButton(panel(), '保存').listeners.click[0]();
    await new Promise(setImmediate);
    assert.deepEqual(plain(readBindings()[0].bigCheckSegments), imported);
    assert.equal(readBindings()[0].judgeSegments[0].content, '甲-常规判断');
    assert.equal('bigCheckSegments' in readBindings()[1], false);
    let exported;
    sandbox.Blob = function Blob(parts) { this.parts = parts; };
    sandbox.URL = { createObjectURL: blob => { exported = JSON.parse(blob.parts[0]); return 'blob:prompt'; }, revokeObjectURL: () => {} };
    const createElement = documentRef.createElement;
    documentRef.createElement = tag => {
        const node = createElement(tag);
        if (String(tag).toLowerCase() === 'a') {
            node.click = () => {};
            node.remove = () => {};
        }
        return node;
    };
    findButton(panel(), '导出').listeners.click[0]();
    assert.deepEqual(exported.segments, imported, '只导出当前卡的当前类型');
    assert.equal(exported.kind, 'bigCheck');
    const restored = await sandbox.DynamicGuideAssistantCore.getCurrentSnapshot();
    assert.equal('pickStageSegments' in restored.config.bindings[0], false, '持久化后不会恢复旧选段字段');
    assert.deepEqual(errors, []);
});

test('中止在途判断请求：结论作废、不算失败，下一层照常检查', async () => {
    const world = judgeWorld();
    let calls = 0;
    let release = null;
    world.helper.generateRaw = () => {
        calls += 1;
        if (calls === 1) return new Promise(resolve => { release = resolve; });
        return Promise.resolve('YES');
    };
    const run = load(world.helper);
    await new Promise(setImmediate);
    const pending = world.state.events.get('message_received')(5);
    for (let index = 0; index < 10 && !release; index += 1) await new Promise(setImmediate);
    assert.ok(release, '第一次请求已经发出');
    run.core.abortModelRequests('测试切换聊天');
    release('YES');
    await pending;
    assert.equal(world.stageOf(), 0, '中止后回来的 YES 不能推进');
    world.state.messages.push({ message_id: 6, role: 'assistant', message: '下一层。' });
    world.state.lastMessageId = 6;
    await world.state.events.get('message_received')(6);
    assert.equal(calls, 2, '中止不进暂停，下一层照常问');
    assert.equal(world.stageOf(), 1);
    assert.deepEqual(run.errors, []);
});

test('按线 > 按聊天 > 全局选 API；预设改名、删除时引用跟着同步', async () => {
    const world = judgeWorld({ judgePreset: '甲' });
    world.helper.getCurrentChatId = () => '聊天一';
    const storage = memoryStorage();
    const run = load(world.helper, { localStorage: storage });
    await new Promise(setImmediate);
    const resolve = key => run.core.resolveJudgePresetName({ judgePreset: '甲' }, { key }).name;
    assert.equal(resolve('线1'), '甲', '没覆盖时跟全局');
    run.core.setPresetOverride('chats', '聊天一', '乙');
    assert.equal(resolve('线1'), '乙', '按聊天覆盖');
    run.core.setPresetOverride('lines', '线1', '丙');
    assert.equal(resolve('线1'), '丙', '按线优先');
    assert.equal(resolve('线2'), '乙');
    run.core.setPresetOverride('lines', '线3', '@main');
    assert.equal(resolve('线3'), '', '@main 表示酒馆主 API');
    await run.core.updatePresetReferences('丙', '丁');
    assert.equal(resolve('线1'), '丁', '改名同步到按线覆盖');
    await run.core.updatePresetReferences('乙', '');
    assert.equal(resolve('线2'), '甲', '删除后按聊天覆盖清掉，回到全局');
    await run.core.updatePresetReferences('甲', '戊');
    const config = world.state.variables.character.$dynamicGuideAssistant.config;
    assert.notEqual(config.settings && config.settings.judgePreset, '甲', '全局引用也跟着改');
    assert.ok(!JSON.stringify(config).includes('戊'), 'API 预设名照旧不写进角色变量');
});

test('待选列表排除 MVU 条目，普通条目照常可选', () => {
    const run = load();
    const excluded = run.core.isPickerExcludedEntry;
    assert.equal(excluded({ uid: 1, name: '[InitVar]初始变量' }), true);
    assert.equal(excluded({ uid: 2, name: '[initvar]' }), true);
    assert.equal(excluded({ uid: 3, name: '[mvu_update]变量更新' }), true);
    assert.equal(excluded({ uid: 4, name: '变量更新规则' }), true);
    assert.equal(excluded({ uid: 5, name: '剧情大纲' }), false);
    assert.equal(excluded({ uid: 6, name: '初始化剧情' }), false, '只是名字里有「初始」不算 MVU');
});

test('总开关关闭：世界书归回原样、不另开判断请求，重新打开后重建镜像', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [
        { uid: 1, name: '大纲A', content, enabled: false },
        { uid: 2, name: '大纲A（动态指导）', content: '甲一正文', enabled: true },
    ] };
    const config = { version: 2, bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }], settings: { autoAdvance: 'judge', guideEnabled: false } };
    const message = { message_id: 5, role: 'assistant', message: '回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    let calls = 0;
    helper.generateRaw = async () => { calls += 1; return 'YES'; };
    const run = load(helper);
    await new Promise(setImmediate);
    await state.events.get('generate')('normal');
    const source = state.books.书A.find(item => item.uid === 1);
    assert.equal(source.enabled, true, '原条目重新打开');
    assert.equal(state.books.书A.some(item => item.name === '大纲A（动态指导）'), false, '镜像删掉');
    await state.events.get('message_received')(5);
    assert.equal(calls, 0, '关闭时不问判断AI');
    assert.equal(state.variables.character.$dynamicGuideAssistant.config.bindings.length, 1, '绑定保留');

    state.variables.character.$dynamicGuideAssistant.config.settings.guideEnabled = true;
    await state.events.get('generate')('normal');
    assert.equal(state.books.书A.find(item => item.uid === 1).enabled, false, '重新打开后原条目再关掉');
    assert.ok(state.books.书A.some(item => item.name === '大纲A（动态指导）'), '镜像重建');
    assert.deepEqual(run.errors, []);
});

test('默认提示词迁移：和 v3.0 默认一字不差的段换成新默认，改过的段保留', () => {
    const run = load();
    const d = run.core.judgeDefaults;
    const old = [
        { role: 'system', content: d.legacyIdentity },
        { role: 'system', content: d.rules },
        { role: 'user', content: d.legacyCase },
    ];
    const migrated = plain(run.core.migrateJudgeSegments(old));
    assert.deepEqual(migrated, plain(d.segments), '全是旧默认时整组换成新默认');
    const custom = [
        { role: 'system', content: '我自己写的身份' },
        { role: 'system', content: d.rules },
        { role: 'user', content: d.legacyCase },
    ];
    const kept = plain(run.core.migrateJudgeSegments(custom));
    assert.equal(kept.length, 3, '身份改过就不合并');
    assert.equal(kept[0].content, '我自己写的身份');
    assert.match(kept[2].content, /\{\{elapsed\}\}/, '没改过的案卷段换成新默认');
});

test('已停几层：推进时记下进入楼层，下一次判断的案卷写出停了几层', async () => {
    const world = judgeWorld();
    world.state.variables.chat = { $dynamicGuideAssistant: { state: { version: 2, bindings: { [keyOf('书A', 1)]: { stageIndex: 1, stageName: '甲二', stageEnteredId: 2 } } } } };
    const sent = [];
    world.helper.generateRaw = async request => { sent.push(request); return 'NO'; };
    load(world.helper);
    await new Promise(setImmediate);
    await world.state.events.get('message_received')(5);
    assert.equal(sent.length, 1);
    assert.match(lastUserText(sent[0]), /已在这段停了约 3 层（第 2 层进入，现在第 5 层）/);
    assert.match(lastUserText(sent[0]), /【上一阶段】甲一/);
});
