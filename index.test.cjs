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

test('v2 只发送当前阶段、范围内附加和常驻内容', () => {
    const parsed = core.parseOutline('## 第一幕\n完成：正式交谈结束。\n当前正文\n\n## 第二幕\n未来正文\n\n## 道具 [附加]\n从：第一幕\n到：第二幕\n道具正文\n\n## 风格 [常驻]\n风格正文\n\n## 秘密 [备注]\n不应发送');
    assert.equal(parsed.stages.length, 2);
    assert.deepEqual(plain(core.activeAddons(parsed, 0).map(item => item.name)), ['道具', '风格']);
    const injected = core.formatInjection(parsed.stages[0], core.activeAddons(parsed, 0));
    assert.match(injected, /当前正文/);
    assert.match(injected, /DGA_COMPLETE:/);
    assert.doesNotMatch(injected, /未来正文|不应发送/);
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

test('阶段改名保留直接、带引号、多行和数字引用的端点', () => {
    const input = '## 第一幕\n正文一\n\n## 第二幕\n正文二\n\n## 道具 [附加]\n从：第一幕\n到：《第二幕》结束时\n道具正文\n\\到：第二幕\n\n## 多行道具 [附加]\n从：\n“第一幕”正在进行时\n\n到：\n《第二幕》结束时\n\n多行正文\n\n## 数字道具 [附加]\n从：1\n到：2\n数字正文';
    let parsed = core.parseOutline(input);
    let lines = core.replaceHeading(parsed.lines, parsed.stages[1], { kind: 'stage', name: '新第二幕' });
    parsed = core.parseOutline(lines.join('\n'));
    lines = core.replaceHeading(parsed.lines, parsed.stages[0], { kind: 'stage', name: '新第一幕' });
    parsed = core.parseOutline(lines.join('\n'));
    assert.deepEqual(plain(parsed.addons.map(item => [item.fromIndex, item.toIndex])), [[0, 1], [0, 1], [0, 1]]);
    assert.equal(parsed.warnings.length, 0);
    assert.equal(parsed.addons[0].prompt, '道具正文\n到：第二幕');
    assert.equal(parsed.addons[1].prompt, '多行正文');
    assert.equal(parsed.addons[2].labels.to, '2');
});

test('标题编辑和删除不会把转义正文改成结构', () => {
    let parsed = core.parseOutline('## 第一幕\n\\## 正文小标题\n\\完成：正文内容\n\n## 第二幕\n第二幕正文');
    let lines = core.replaceHeading(parsed.lines, parsed.stages[0], { kind: 'stage', name: '开场', completion: '完成对话。' });
    parsed = core.parseOutline(lines.join('\n'));
    assert.equal(parsed.stages[0].prompt, '## 正文小标题\n完成：正文内容');
    lines = core.deleteHeading(parsed.lines, parsed.stages[1]);
    parsed = core.parseOutline(lines.join('\n'));
    assert.equal(parsed.stages.length, 1);
    assert.equal(parsed.stages[0].prompt, '## 正文小标题\n完成：正文内容\n\n第二幕正文');
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

function runtime(entry) {
    const { state, helper } = helperFor(entry);
    return {
        ...load(helper),
        injected: state.injected,
        injectionOptions: state.injectionOptions,
        active: state.active,
        removed: state.removed,
        generate: async () => state.events.get('generate')('normal', {}, false),
    };
}

for (const storage of ['extra', 'embedded']) {
    test(`尚未转换的 ${storage} 旧布局停止注入并提示转换`, async () => {
        const text = '## 旧原文里的秘密\n不应按新格式发送';
        const layout = { mode: 'ranges', stages: [{ name: '旧阶段', ranges: [range(text, '不应按新格式发送')] }] };
        const entry = { uid: 1, name: '大纲', content: text, enabled: false };
        if (storage === 'extra') entry.extra = { dynamicGuideAssistant: { layout } };
        else entry.content += `\n<!-- DGA_LAYOUT_V1:BEGIN -->${Buffer.from(JSON.stringify(layout)).toString('base64')}<!-- DGA_LAYOUT_V1:END -->`;
        const run = runtime(entry);
        await run.generate();
        assert.equal(run.injected.length, 0);
        assert.ok(run.removed.includes('dynamic-guide-assistant-current'), '要清掉旧版无后缀注入');
        assert.ok(run.removed.some(id => id.startsWith('dynamic-guide-assistant-current-')), '要清掉这条绑定自己的注入');
        assert.match(run.logs.join('\n'), /转换成新版格式/);
        assert.deepEqual(run.errors, []);
    });
}

test('新格式仍正常注入且重新禁用意外启用的来源条目', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文\n\n## 第二幕\n未来秘密', enabled: true };
    const run = runtime(entry);
    await run.generate();
    assert.equal(run.active.size, 1, '当前应只有一条活跃注入');
    const live = [...run.active.values()][0];
    assert.match(live.content, /当前正文/);
    assert.doesNotMatch(live.content, /未来秘密/);
    assert.equal(entry.enabled, false);
    assert.deepEqual(run.errors, []);
});

test('生成事件等待异步读取和注入完成后才允许请求继续', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n必须出现的当前正文', enabled: false };
    const { state, helper } = helperFor(entry);
    let releaseWorldbook;
    helper.getWorldbook = () => new Promise(resolve => {
        releaseWorldbook = () => resolve(state.entries);
    });
    const run = load(helper);
    const generation = state.events.get('generate')('normal', {}, false);
    let finished = false;
    Promise.resolve(generation).then(() => { finished = true; });
    await new Promise(setImmediate);
    assert.equal(finished, false, '世界书还没读完时，生成事件不能提前结束');
    assert.equal(state.injected.length, 0);
    releaseWorldbook();
    await generation;
    assert.equal(finished, true);
    assert.equal(state.active.size, 1);
    assert.match([...state.active.values()][0].content, /必须出现的当前正文/);
    assert.deepEqual(run.errors, []);
});

test('打开页面就注入当前阶段，进度一变立刻换成新阶段', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n第一段正文\n\n## 第二幕\n第二段正文', enabled: false };
    const run = runtime(entry);
    await new Promise(setImmediate);
    assert.equal(run.injected.length, 1, '打开页面就该注入，不必等生成事件');
    assert.match(run.injected[0].content, /第一段正文/);
    await run.core.next();
    assert.equal(run.injected.length, 2, '进度推进后立刻更新注入内容');
    assert.match(run.injected[1].content, /第二段正文/);
    assert.doesNotMatch(run.injected[1].content, /第一段正文/);
    assert.deepEqual(run.errors, []);
});

test('swipe 重新生成时同步注入的是推进前的阶段', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n第一段正文\n\n## 第二幕\n第二段正文', enabled: false };
    const { state, helper } = helperFor(entry);
    state.variables.chat.$dynamicGuideAssistant = {
        state: { stageIndex: 1, stageName: '第二幕', lastCompletionMessageId: 7, lastCompletionFingerprint: 'x' },
    };
    helper.getLastMessageId = () => 7;
    const run = load(helper);
    await new Promise(setImmediate);
    assert.match(state.injected[state.injected.length - 1].content, /第二段正文/);
    state.injected.length = 0;
    const generation = state.events.get('generate')('swipe', {}, false);
    assert.equal(state.injected.length, 1, '不等待生成事件也要先注入推进前的阶段');
    assert.match(state.injected[0].content, /第一段正文/);
    assert.doesNotMatch(state.injected[0].content, /第二段正文/);
    await generation;
    assert.deepEqual(run.errors, []);
});

// v2.3.1 回归：v2.0–v2.3 的“内容没变就跳过注入”去重，会让被外部清掉的注入永远补不回来
test('注入被外部清掉后，下一次生成事件会无条件重新注入', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文', enabled: false };
    const run = runtime(entry);
    await new Promise(setImmediate);
    assert.equal(run.active.size, 1, '打开页面就该有一条活跃注入');
    const id = [...run.active.keys()][0];
    // 模拟酒馆助手在脚本重载等时机自动清掉持久注入：脚本对此毫不知情
    run.active.clear();
    await run.generate();
    assert.equal(run.active.size, 1, '生成事件必须重新注入，不能因病缓存跳过');
    assert.match([...run.active.values()][0].content, /当前正文/);
    assert.ok(run.removed.includes(id), '重新注入前要先按 id 撤掉旧注入');
    assert.ok(
        run.injectionOptions.some(options => options && options.once === true),
        '注入必须带 once: true，只对下一次请求生效，与 1.3.6 一致',
    );
    assert.deepEqual(run.errors, []);
});

test('dryRun 预组装（提示词查看器）也会注入当前指导', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文', enabled: false };
    const { state, helper } = helperFor(entry);
    const run = load(helper);
    await new Promise(setImmediate);
    state.active.clear();
    await state.events.get('generate')('normal', {}, true);
    assert.equal(state.active.size, 1, 'dryRun 也要注入，提示词查看器才能看到当前阶段');
    assert.deepEqual(run.errors, []);
});

// v2.4 双通道：酒馆助手注入接口缺失或报错时，退回酒馆原生 setExtensionPrompt(IN_CHAT)
test('酒馆助手没有注入接口时，改走原生 IN_CHAT 深度注入', async () => {
    const calls = [];
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (id, text, position, depth, scan, role) => calls.push({ id, text, position, depth, role }),
        }),
    };
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n原生通道正文',
        enabled: false,
        position: { type: 'at_depth', depth: 4, role: 'assistant' },
    };
    const { state, helper } = helperFor(entry);
    delete helper.injectPrompts;
    delete helper.uninjectPrompts;
    const run = load(helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    assert.equal(state.injected.length, 0, '助手通道缺失时不走 injectPrompts');
    const live = calls.filter(call => call.text);
    assert.equal(live.length, 1, '原生通道要写一条注入');
    assert.equal(live[0].position, 1, '原生聊天内注入对应 IN_CHAT=1');
    assert.equal(live[0].depth, 4, '深度跟随条目');
    assert.equal(live[0].role, 2, 'assistant 对应原生角色码 2');
    assert.match(live[0].text, /原生通道正文/);
    assert.deepEqual(run.errors, []);
});

test('注入接口调用抛错时也退回原生通道', async () => {
    const calls = [];
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (id, text, position, depth) => calls.push({ id, text, position, depth }),
        }),
    };
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n回退正文', enabled: false };
    const { helper } = helperFor(entry);
    helper.injectPrompts = () => { throw new Error('模拟注入接口报错'); };
    const run = load(helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    const live = calls.filter(call => call.text);
    assert.equal(live.length, 1, '接口报错后原生通道要接管');
    assert.match(live[0].text, /回退正文/);
    assert.match(run.logs.join('\n'), /改用酒馆原生注入/);
    assert.deepEqual(run.errors, []);
});

test('诊断：链路完好时全部通过，缺注入接口时明确标出', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false };
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: () => {},
            extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
        }),
    };
    const good = helperFor(entry);
    good.helper.getWorldbookNames = () => ['测试世界书'];
    good.helper.getCharWorldbookNames = () => ['测试世界书'];
    good.helper.getCharData = () => ({ name: '测试角色' });
    good.helper.getLastMessageId = () => 0;
    const run = load(good.helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    const rows = plain(await run.core.diagnose());
    const failed = rows.filter(row => !row.ok);
    assert.deepEqual(failed.map(row => row.label), [], `全部应通过，未通过：${failed.map(row => row.label).join('、')}`);
    const bad = helperFor(entry);
    delete bad.helper.injectPrompts;
    const runBad = load(bad.helper, { SillyTavern: sillyTavern });
    const badRows = plain(await runBad.core.diagnose());
    const probe = badRows.find(row => row.label === '试注：酒馆助手通道');
    assert.equal(probe.ok, false, '缺 injectPrompts 时试注要标出');
    assert.match(probe.detail, /缺失/);
    assert.deepEqual(runBad.errors, []);
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

function findClass(node, name, skipSelf) {
    if (!skipSelf && String(node.className || '').split(/\s+/).includes(name)) return node;
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

test('编辑器写出的“并入”标题能解析，阶段改名时引用同步更新', () => {
    let parsed = core.parseOutline('## 第一幕\n正文一\n\n## 第二幕\n正文二');
    const lines = core.insertHeading(parsed.lines, parsed.lines.length, { kind: 'merged', name: '补充', merge: '第一幕' });
    parsed = core.parseOutline(lines.join('\n'));
    const merged = parsed.blocks.find(item => item.kind === 'merged');
    assert.ok(merged, '写出的“合并到：”应当被解析成并入块');
    assert.equal(merged.name, '补充');
    assert.equal(parsed.stages.length, 2);
    const renamed = core.replaceHeading(parsed.lines, parsed.stages[0], { kind: 'stage', name: '开场' });
    const after = core.parseOutline(renamed.join('\n'));
    assert.equal(after.stages[0].name, '开场');
    assert.equal(after.blocks.find(item => item.kind === 'merged').labels.merge, '开场');
});

test('注入位置跟随大纲条目的深度与角色', async () => {
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n正文',
        enabled: false,
        position: { type: 'at_depth', depth: 4, role: 'assistant', order: 100 },
    };
    const run = runtime(entry);
    await new Promise(setImmediate);
    assert.equal(run.injected.length, 1);
    assert.equal(run.injected[0].depth, 4);
    assert.equal(run.injected[0].role, 'assistant');
    assert.deepEqual(run.errors, []);
});

test('没有原生扩展提示接口时，角色定义前的条目退化为聊天末尾', async () => {
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n正文',
        enabled: false,
        position: { type: 'before_character_definition', depth: 4, role: 'user', order: 100 },
    };
    const run = runtime(entry);
    await new Promise(setImmediate);
    assert.equal(run.injected.length, 1);
    assert.equal(run.injected[0].depth, 0);
    assert.equal(run.injected[0].role, 'system');
    assert.deepEqual(run.errors, []);
});

// 原生扩展提示的数值常量来自酒馆源码 extension_prompt_types：NONE=-1, IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2
test('角色定义前的条目通过原生扩展提示锚点注入，切换聊天时清理', async () => {
    const calls = [];
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (id, text, position, depth) => calls.push({ id, text, position, depth }),
        }),
    };
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n前置正文',
        enabled: false,
        position: { type: 'before_character_definition', depth: 0, role: 'system', order: 100 },
    };
    const { state, helper } = helperFor(entry);
    const run = load(helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    assert.equal(state.injected.length, 0, '锚点位置不走 injectPrompts');
    const anchored = calls.filter(call => call.text);
    assert.equal(anchored.length, 1, '打开页面就该写原生扩展提示');
    assert.match(anchored[0].id, /^dynamic-guide-assistant-current-/, '注入 id 带绑定指纹后缀');
    assert.equal(anchored[0].position, 2, '角色定义前对应 BEFORE_PROMPT=2');
    assert.match(anchored[0].text, /前置正文/);
    await state.events.get('chat_changed')();
    assert.ok(calls.some(call => call.text === '' && call.position === -1), '切换聊天时要写空内容到 NONE 位置清理');
    assert.equal(calls[calls.length - 1].position, 2, '清理后按新聊天状态重新注入');
    assert.deepEqual(run.errors, []);
});

test('角色定义后的条目用 IN_PROMPT 锚点，不识别的位置仍放聊天末尾', async () => {
    const calls = [];
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (id, text, position, depth) => calls.push({ id, text, position, depth }),
        }),
    };
    const afterEntry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n后置正文',
        enabled: false,
        position: { type: 'after_character_definition', depth: 0, role: 'system', order: 100 },
    };
    const runAfter = runtime(afterEntry);
    await new Promise(setImmediate);
    // runtime() 的沙箱里没有 SillyTavern，这条只验证深度回退；锚点验证见上面的测试
    assert.equal(runAfter.injected.length, 1);
    assert.equal(runAfter.injected[0].depth, 0);
    const withSilly = load(helperFor({
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n后置正文',
        enabled: false,
        position: { type: 'after_character_definition', depth: 0, role: 'system', order: 100 },
    }).helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    const anchored = calls.filter(call => call.text);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].position, 0, '角色定义后对应 IN_PROMPT=0');
    assert.match(anchored[0].text, /后置正文/);
    assert.deepEqual(withSilly.errors, []);
});

test('示例消息等其余位置的条目即使有原生接口也仍放聊天末尾', async () => {
    const calls = [];
    const sillyTavern = {
        getContext: () => ({
            setExtensionPrompt: (id, text, position, depth) => calls.push({ id, text, position, depth }),
        }),
    };
    const entry = {
        uid: 1,
        name: '大纲',
        content: '## 第一幕\n正文',
        enabled: false,
        position: { type: 'before_example_messages', depth: 6, role: 'user', order: 100 },
    };
    const { state, helper } = helperFor(entry);
    const run = load(helper, { SillyTavern: sillyTavern });
    await new Promise(setImmediate);
    assert.equal(state.injected.length, 1);
    assert.equal(state.injected[0].depth, 0);
    assert.equal(state.injected[0].role, 'system');
    assert.equal(calls.filter(call => call.text).length, 0, '没有可复制通道的位置不能写入扩展提示锚点');
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
        getChatMessages: id => state.messages.filter(message => message.message_id === id),
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
    assert.equal(state.injected.length, 1);
    assert.match(state.injected[0].content, /第二段正文/, '旧进度要落到第一个绑定名下');
    assert.doesNotMatch(state.injected[0].content, /第一段正文/);
    const chatState = state.variables.chat.$dynamicGuideAssistant.state;
    assert.equal(chatState.version, 2, '旧进度读出后立刻写回新结构');
    assert.equal(chatState.bindings[keyOf('测试世界书', 1)].stageIndex, 1);
    assert.deepEqual(run.errors, []);
});

test('两条绑定各自注入回自己的位置', async () => {
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
    assert.equal(state.injected.length, 2, '每条绑定各注入一条');
    const a = state.injected.find(item => item.depth === 4);
    const b = state.injected.find(item => item.depth === 0);
    assert.ok(a && b);
    assert.equal(a.role, 'assistant');
    assert.match(a.content, /甲一正文/);
    assert.doesNotMatch(a.content, /甲二正文/);
    assert.match(b.content, /乙一正文/);
    assert.notEqual(a.id, b.id, '两条注入的 id 不能互相覆盖');
    assert.match(a.id, /^dynamic-guide-assistant-current-/);
    await run.core.next();
    const aNext = state.injected.filter(item => item.id === a.id).pop();
    assert.match(aNext.content, /甲二正文/);
    assert.doesNotMatch(aNext.content, /甲一正文/);
    assert.match(state.active.get(b.id).content, /乙一正文/, 'B 的注入内容不受影响');
    assert.deepEqual(run.errors, []);
});

test('一条消息里的完成标记只推进匹配的那条绑定', async () => {
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
    const chatState = state.variables.chat.$dynamicGuideAssistant.state;
    assert.equal(chatState.bindings[keyOf('书A', 1)].stageIndex, 0, 'A 不该被推进');
    assert.equal(chatState.bindings[keyOf('书B', 2)].stageIndex, 1, 'B 要被推进');
    assert.equal(message.message.includes('DGA_COMPLETE'), false, '标记要从消息里清掉');
    const lastB = state.injected.filter(item => /乙/.test(item.content)).pop();
    assert.match(lastB.content, /乙二正文/);
    assert.doesNotMatch(lastB.content, /乙一正文/);
    assert.deepEqual(run.errors, []);
});

test('移出绑定会重新打开条目、删掉进度并清掉它的注入', async () => {
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
    assert.equal(state.injected.length, 2);
    const idA = state.injected.find(item => /甲一正文/.test(item.content)).id;
    await run.core.unbind(keyOf('书A', 1), { confirm: false });
    assert.equal(books.书A[0].enabled, true, '条目要重新打开');
    assert.equal(books.书B[0].enabled, false, '其他绑定不受影响');
    const remaining = state.variables.character.$dynamicGuideAssistant.config.bindings;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].worldbookName, '书B');
    const chatState = state.variables.chat.$dynamicGuideAssistant.state;
    assert.equal(chatState.bindings[keyOf('书A', 1)], undefined, '进度要删掉');
    assert.ok(state.removed.includes(idA), '这条绑定的注入要清掉');
    await state.events.get('generate')('normal', {}, false);
    assert.equal(state.injected.filter(item => item.id === idA).length, 1, '移出后不会再注入这条绑定');
    assert.deepEqual(run.errors, []);
});


// ---------------------------------------------------------------
// v2.2 选区划分：正文铺成连续文字，拖选后分配给分段，结构立刻重建
// ---------------------------------------------------------------

test('选区模式：载入→重建往返幂等，保留前缀、转义、并入和附加范围', () => {
    const content = '前言一\n前言二\n\n## 第一幕\n完成：交谈结束。\n\\## 小标题\n第一幕正文\n\n## 第二幕\n第二幕正文\n\n## 补充\n合并到：第一幕\n补充正文\n\n## 道具 [附加]\n从：第一幕\n到：第二幕\n道具正文\n\n## 风格 [常驻]\n风格正文\n\n## 秘密 [备注]\n备注正文';
    const first = core.pickBuild(core.pickLoad(core.parseOutline(content)));
    const second = core.pickBuild(core.pickLoad(core.parseOutline(first)));
    assert.equal(second, first, '第一次重建后再次载入重建必须逐字相同');
    assert.ok(first.startsWith('前言一\n前言二'), '没有归属的文字保留在最前面');
    const parsed = core.parseOutline(first);
    assert.deepEqual(plain(parsed.stages.map(item => [item.name, item.prompt])), [
        ['第一幕', '## 小标题\n第一幕正文\n\n补充正文'],
        ['第二幕', '第二幕正文'],
    ]);
    assert.equal(parsed.stages[0].completion, '交谈结束。');
    assert.deepEqual(plain(parsed.addons.map(item => [item.name, item.prompt])), [['道具', '道具正文'], ['常驻提示', '风格正文']]);
    const addon = parsed.addons.find(item => item.kind === 'addon');
    assert.equal(addon.fromIndex, 0);
    assert.equal(addon.toIndex, 1);
    assert.equal(parsed.blocks.find(item => item.kind === 'always').prompt, '风格正文');
    assert.equal(parsed.blocks.find(item => item.kind === 'note').prompt, '备注正文');
    parsed.stages.forEach(stage => assert.doesNotMatch(stage.prompt, /前言/));
});

test('选区模式：给未分段正文分配区间，重建出正确的标题结构', () => {
    const parsed = core.parseOutline('开头铺垫\n\n冲突爆发\n\n结局收尾');
    const pick = core.pickLoad(parsed);
    assert.equal(pick.stages.length, 0);
    const at = quote => {
        const start = pick.text.indexOf(quote);
        return { start, end: start + quote.length };
    };
    pick.stages.push(
        { id: 's1', kind: 'stage', name: '第一幕', completion: '', ranges: [], color: '#111111' },
        { id: 's2', kind: 'stage', name: '第二幕', completion: '冲突结束。', ranges: [], color: '#222222' },
    );
    assert.ok(core.pickAssign(pick, 's1', [at('开头铺垫')]));
    assert.ok(core.pickAssign(pick, 's2', [at('冲突爆发')]));
    const built = core.pickBuild(pick);
    assert.ok(built.startsWith('结局收尾'), '没分配的文字收在最前面当前言，不发给 AI');
    assert.ok(built.indexOf('结局收尾') < built.indexOf('## 第一幕'));
    const next = core.parseOutline(built);
    assert.deepEqual(plain(next.stages.map(item => [item.name, item.prompt])), [['第一幕', '开头铺垫'], ['第二幕', '冲突爆发']]);
    assert.equal(next.stages[1].completion, '冲突结束。');
    next.stages.forEach(stage => assert.doesNotMatch(stage.prompt, /结局收尾/));
});

test('选区模式：把别人已分配的文字重新选一遍就改归新属主', () => {
    const parsed = core.parseOutline('## 第一幕\naaa bbb ccc\n\n## 第二幕\nddd');
    const pick = core.pickLoad(parsed);
    const [firstStage, secondStage] = pick.stages;
    const range = { start: pick.text.indexOf('bbb'), end: pick.text.indexOf('ddd') };
    assert.ok(core.pickAssign(pick, secondStage.id, [range]));
    assert.deepEqual(plain(firstStage.ranges), [{ start: 0, end: pick.text.indexOf('bbb') }], '被挖走的部分要从原属主手里减掉');
    const rebuilt = core.parseOutline(core.pickBuild(pick));
    assert.equal(rebuilt.stages[0].prompt, 'aaa');
    assert.equal(rebuilt.stages[1].prompt, 'bbb ccc\n\nddd');
});

test('选区模式：移除选中段后，文字回到最前面的未分配区', () => {
    const parsed = core.parseOutline('## 第一幕\n保留部分 丢弃部分');
    const pick = core.pickLoad(parsed);
    const stage = pick.stages[0];
    const range = { start: pick.text.indexOf('丢弃'), end: pick.text.length };
    assert.ok(core.pickRemove(pick, stage.id, range));
    const built = core.pickBuild(pick);
    assert.ok(built.startsWith('丢弃部分'));
    const rebuilt = core.parseOutline(built);
    assert.equal(rebuilt.stages[0].prompt, '保留部分');
    assert.equal(core.pickRemove(pick, 'note', range), false, '没有这段的属主不该报成功');
});

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

test('选区模式界面：拖选前言分配给第一阶段，正文立刻重建并标脏', async () => {
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
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '前言介绍\n\n## 第一幕\n第一幕正文', enabled: false });
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
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
    const pickTab = panel.querySelector('.dga-mode-pick');
    assert.ok(pickTab, '编辑器要有“选区划分”模式按钮');
    pickTab.listeners.click[0]();

    let surface = panel.querySelector('.dga-pick-surface');
    assert.ok(surface, '选区模式要把正文铺成连续文字');
    assert.match(surface.textContent, /前言介绍\n\n第一幕正文/);
    const texts = collectTextNodes(surface, []);
    assert.equal(texts[0].textContent, '前言介绍\n\n', '前言和分隔符在第一个文本节点里（未分配，没有底色）');

    selection.select(texts[0], 0, texts[0], 4);
    surface.listeners.mousedown[0]();
    surface.listeners.mouseup[0]();
    assert.match(panel.querySelector('.dga-pick-bar-text').textContent, /已准备 1 段/, '拖选后选区栏要显示待分配数量');
    assert.equal(selection.rangeCount, 0, '捕获后系统选区要清掉，改由我们的底色显示');

    const assign = findButton(panel, '分配给');
    assert.ok(assign, '选区栏要有分配按钮');
    assign.listeners.click[0]();
    surface = panel.querySelector('.dga-pick-surface');
    const firstSpan = surface.children[0];
    assert.ok(firstSpan.classList && firstSpan.classList.contains('dga-text-mark'), '分配后前言要包进第一幕的底色');
    assert.match(firstSpan.textContent, /前言介绍/);
    const subtitle = panel.querySelector('.dga-head-text').children[1];
    assert.match(subtitle.textContent, /未保存/, '分配是结构性修改，头部要提示未保存');
    assert.deepEqual(errors, []);
});


// ---------------------------------------------------------------
// v2.3 顺序编辑：整块上移/下移；常驻写在阶段之前 = 注入排在阶段内容之前
// ---------------------------------------------------------------

test('整块上移下移：交换阶段顺序，附加的“从：第一幕”按名字跟随', () => {
    const content = '前言文字\n\n## 第一幕\n正文一\n\n## 第二幕\n正文二\n\n## 道具 [附加]\n从：第一幕\n道具正文\n\n## 风格 [常驻]\n风格正文';
    let parsed = core.parseOutline(content);
    let lines = core.moveBlock(parsed.lines, parsed.stages[0], 1);
    assert.ok(!lines.join('\n').includes('\n\n\n'), '搬移后不出现连续两个空行');
    parsed = core.parseOutline(lines.join('\n'));
    assert.deepEqual(plain(parsed.stages.map(item => item.name)), ['第二幕', '第一幕']);
    assert.deepEqual(plain(parsed.stages.map(item => item.prompt)), ['正文二', '正文一']);
    const addon = parsed.addons.find(item => item.kind === 'addon');
    assert.equal(addon.fromIndex, 1, '阶段引用按名字解析，换位后自动跟随');
    assert.deepEqual(core.moveBlock(parsed.lines, parsed.blocks[0], -1), parsed.lines, '第一个块不能再上移');
    assert.deepEqual(core.moveBlock(parsed.lines, parsed.blocks[parsed.blocks.length - 1], 1), parsed.lines, '最后一个块不能再下移');
});

test('常驻挪到所有阶段之前，注入里就排在当前阶段内容之前', () => {
    const content = '前言文字\n\n## 第一幕\n正文一\n\n## 风格 [常驻]\n风格正文';
    let parsed = core.parseOutline(content);
    assert.equal(parsed.blocks.find(item => item.kind === 'always').aboveStages, false);
    // 常驻上移一次到前言之后、第一幕之前
    const lines = core.moveBlock(parsed.lines, parsed.blocks.find(item => item.kind === 'always'), -1);
    assert.ok(lines.join('\n').startsWith('前言文字'), '前言保持在最前，搬移只在标题块之间进行');
    parsed = core.parseOutline(lines.join('\n'));
    const always = parsed.blocks.find(item => item.kind === 'always');
    assert.equal(always.aboveStages, true, '常驻在所有阶段之前要标记为“在上面”');
    const injected = core.formatInjection(parsed.stages[0], core.activeAddons(parsed, 0));
    assert.ok(injected.indexOf('风格正文') < injected.indexOf('正文一'), '注入里常驻排在阶段内容之前');
    assert.match(injected, /## 常驻提示[\s\S]*## 当前阶段/);
    // 写在后面的常驻保持在附加内容区
    const bottom = core.parseOutline(content);
    const injectedBottom = core.formatInjection(bottom.stages[0], core.activeAddons(bottom, 0));
    assert.ok(injectedBottom.indexOf('风格正文') > injectedBottom.indexOf('正文一'));
    assert.match(injectedBottom, /## 同时有效的附加内容[\s\S]*风格正文/);
});

test('选区模式重建保留常驻的前后位置，开关可以切换', () => {
    const top = core.parseOutline('## 风格 [常驻]\n风格正文\n\n## 第一幕\n正文一\n\n## 第二幕\n正文二');
    const pickTop = core.pickLoad(top);
    assert.equal(pickTop.alwaysTop, true);
    const rebuiltTop = core.parseOutline(core.pickBuild(pickTop));
    assert.equal(rebuiltTop.blocks.find(item => item.kind === 'always').aboveStages, true, '重建后常驻仍在阶段之前');

    const bottom = core.parseOutline('## 第一幕\n正文一\n\n## 风格 [常驻]\n风格正文');
    const pickBottom = core.pickLoad(bottom);
    assert.equal(pickBottom.alwaysTop, false);
    assert.equal(core.parseOutline(core.pickBuild(pickBottom)).blocks.find(item => item.kind === 'always').aboveStages, false);
    pickBottom.alwaysTop = true;
    const flipped = core.parseOutline(core.pickBuild(pickBottom));
    assert.equal(flipped.blocks.find(item => item.kind === 'always').aboveStages, true, '开关切到上面后重建排在阶段之前');
});

test('看分段界面：标题卡的下移按钮交换阶段顺序且不打开弹层', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { state, helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文一\n\n## 第二幕\n正文二', enabled: false });
    state.variables.character.$dynamicGuideAssistant = { config: { version: 2, bindings: [] } };
    const { errors, sandbox } = loadWithDocument(documentRef, helper);
    const uiCore = sandbox.DynamicGuideAssistantCore;
    await new Promise(setImmediate);
    await uiCore.openEditorAt('测试世界书', { uid: 1, name: '大纲' });
    await uiCore.refresh();
    const panel = documentRef.getElementById(PANEL_ID);
    const findAll = (node, cls, out) => {
        if (String(node.className || '').split(/\s+/).includes(cls)) out.push(node);
        (node.children || []).forEach(child => findAll(child, cls, out));
        return out;
    };
    let cards = findAll(panel, 'dga-heading', []);
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, /第一幕/);
    const down = findButton(cards[0], '↓');
    assert.ok(down, '第一张标题卡要有下移按钮');
    down.listeners.click[0]({ stopPropagation() {} });
    cards = findAll(panel, 'dga-heading', []);
    assert.match(cards[0].textContent, /第二幕/, '第二幕被换到上面');
    assert.match(cards[1].textContent, /第一幕/);
    assert.equal(panel.querySelector('.dga-sheet'), null, '点搬移按钮不能打开标题弹层');
    assert.match(panel.querySelector('.dga-head-text').children[1].textContent, /未保存/);
    assert.deepEqual(errors, []);
});
