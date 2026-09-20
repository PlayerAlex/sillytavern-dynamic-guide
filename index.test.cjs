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
    assert.match(injected, /DGA_COMPLETE:/);
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
    const mirrorB = state.books.书B.find(isMirror);
    assert.match(mirrorB.content, /乙二正文/, '推进后 B 的镜像换成新阶段');
    assert.doesNotMatch(mirrorB.content, /乙一正文/);
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

test('formatInjection 只在 auto 档追加通用判断指令，有完成条件时不变成通用块', () => {
    const parsed = core.parseOutline('## 第一幕\n正文一');
    const stage = parsed.stages[0];
    assert.doesNotMatch(core.formatInjection(stage, []), /进入下一段的时机/);
    const marker = core.formatInjection(stage, [], { auto: true });
    assert.match(marker, /进入下一段的时机/);
    assert.match(marker, new RegExp(`DGA_COMPLETE:${stage.id}`));
    const withCondition = core.parseOutline('## 第一幕\n完成：交谈结束。\n正文一');
    const conditional = core.formatInjection(withCondition.stages[0], [], { auto: true });
    assert.match(conditional, /当前阶段的完成判定/);
    assert.doesNotMatch(conditional, /进入下一段的时机/);
});

test('选区模式往返保留“完成：自动”', () => {
    const text = '## 第一幕\n完成：自动\n正文一\n\n## 第二幕\n正文二';
    const rebuilt = core.pickBuild(core.pickLoad(core.parseOutline(text)));
    const again = core.parseOutline(rebuilt);
    assert.equal(again.stages[0].autoComplete, true);
    assert.equal(again.stages[0].completion, '');
    assert.equal(again.stages[1].autoComplete, false);
});

test('标记判断档给没有完成条件的阶段镜像附通用判断指令', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const stageId = core.parseOutline(content).stages[0].id;
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'marker' },
    };
    const { state, helper } = multiWorld(books, { config });
    const run = load(helper);
    await new Promise(setImmediate);
    const mirror = state.books.书A.find(isMirror);
    assert.match(mirror.content, /进入下一段的时机/);
    assert.match(mirror.content, new RegExp(`DGA_COMPLETE:${stageId}`));
    assert.deepEqual(run.errors, []);
});


test('后台裁判档：YES 推进、NO 不推进、同一消息不重复推进', async () => {
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
    assert.equal(verdicts.length, 1, 'judge 档没有标记也要问一次裁判');
    assert.equal(verdicts[0].should_silence, true, '裁判请求必须静默');
    assert.match(String(verdicts[0].user_input), /甲一正文/, '提问要带上阶段正文');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, 'YES 要推进');

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1, '同一消息第二次触发不能重复推进');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1);
    assert.deepEqual(run.errors, []);
});

test('后台裁判档：裁判回答 NO 时不推进', async () => {
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

test('手动推进档不调用后台裁判', async () => {
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
    assert.equal(called, 0, 'off 档没有标记时不能发起裁判请求');
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0);
    assert.deepEqual(run.errors, []);
});


test('后台裁判档：自定义提问模板替换占位符后发出', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgePrompt: '阶段={{stage}}\n条件={{condition}}\n正文={{prompt}}\n历史={{history}}\n走没走？' },
    };
    const message = { message_id: 5, role: 'assistant', message: '这一轮的回复。' };
    const { state, helper } = multiWorld(books, { config, messages: [message], lastMessageId: 5 });
    const verdicts = [];
    helper.generateRaw = async options => { verdicts.push(options); return 'NO'; };
    const run = load(helper);
    await new Promise(setImmediate);

    await state.events.get('message_received')(5);
    assert.equal(verdicts.length, 1);
    const sent = String(verdicts[0].user_input);
    assert.match(sent, /^阶段=甲一/, '模板要按自定义文案组装');
    assert.match(sent, /条件=没有预设完成条件/);
    assert.match(sent, /正文=甲一正文/);
    assert.match(sent, /历史=[\s\S]*这一轮的回复/);
    assert.doesNotMatch(sent, /\{\{/, '占位符要全部替换掉');
    assert.deepEqual(run.errors, []);
});

test('后台裁判档：酒馆预设连接走酒馆连接管理器', async () => {
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
            extensionSettings: { connectionManager: { profiles: [{ id: '酒馆代理A', name: '酒馆代理A' }] } },
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
    assert.equal(cmCalls[0].messages[1].role, 'user');
    assert.match(cmCalls[0].messages[1].content, /这一轮的回复/);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 1, 'YES 要推进');
    assert.deepEqual(run.errors, []);
});

test('后台裁判档：自定义 API 预设直连酒馆后端 generate 端点', async () => {
    const content = '## 甲一\n甲一正文\n\n## 甲二\n甲二正文';
    const books = { 书A: [{ uid: 1, name: '大纲A', content, enabled: false }] };
    const config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 1, entryName: '大纲A', boundAt: null }],
        settings: { autoAdvance: 'judge', judgePreset: '自定义裁判' },
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
            name: '自定义裁判', connection: 'custom', customApiFormat: 'openai_compat',
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
    assert.match(body.messages[1].content, /这一轮的回复/);
    assert.equal(state.variables.chat.$dynamicGuideAssistant.state.bindings[keyOf('书A', 1)].stageIndex, 0, 'NO 不推进');
    assert.deepEqual(run.errors, []);
});

test('后台裁判档：选择不存在的本机预设时不调用 generateRaw', async () => {
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

test('本机裁判 API 预设：连接方式、接口协议与数值字段', () => {
    assert.deepEqual(plain(core.normalizeJudgeApiPreset({
        name: ' 自定义裁判 ', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: ' https://api.example.com/v1 ', key: 'sk-x', model: ' m1 ',
        maxTokens: '24', temperature: '0.3', bodyParams: 'top_k: 50',
    })), {
        name: '自定义裁判', connection: 'custom', customApiFormat: 'claude_messages',
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
    assert.equal(body.max_tokens, 512, '裁判默认 512');
    assert.equal(body.temperature, 1);
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
