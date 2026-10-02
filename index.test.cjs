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
const lastUserText = request => {
    const segments = (request.ordered_prompts || []).filter(item => item && item.role === 'user');
    return segments.length ? String(segments[segments.length - 1].content) : '';
};

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

function findAllClass(node, name, out = []) {
    if (nodeClassNames(node).includes(name)) out.push(node);
    (node.children || []).forEach(child => findAllClass(child, name, out));
    return out;
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

function findButton(node, prefix) {
    if (node.tagName === 'BUTTON' && String(node.textContent || '').includes(prefix)) return node;
    for (const child of node.children || []) {
        const found = findButton(child, prefix);
        if (found) return found;
    }
    return null;
}

test('本机判断AI API 预设：连接方式、接口协议与数值字段', () => {
    assert.deepEqual(plain(core.normalizeJudgeApiPreset({
        name: ' 自定义判断AI ', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: ' https://api.example.com/v1 ', key: 'sk-x', model: ' m1 ',
        maxTokens: '24', temperature: '0.3', bodyParams: 'top_k: 50',
    })), {
        name: '自定义判断AI', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: 'https://api.example.com/v1', key: 'sk-x', model: 'm1',
        maxTokens: 24, temperature: 0.3, bodyParams: 'top_k: 50',
        excludeBodyParams: '', requestHeaders: '', promptPostProcessing: 'strict',
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

test('预设迁移：旧的酒馆预设（tavern / type=proxy）改走酒馆主 API，type=current → main', () => {
    const list = core.normalizeJudgeApiPresets([
        { name: '代理', type: 'proxy', proxyPreset: '酒馆代理A', model: 'm' },
        { name: '主 API', type: 'current' },
        { name: '走酒馆预设', connection: 'tavern', tavernProfile: 'p1' },
    ]);
    assert.equal(list[0].connection, 'main');
    assert.equal(list[1].connection, 'main');
    assert.equal(list[2].connection, 'main', 'v3.7.1 起不再有酒馆预设连接');
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

test('运行日志页：关键词搜索、暂停攒条数、按等级筛选、错误下面附处理建议', async () => {
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
    assert.match(hintNode.textContent, /可能是：.*限流.*可以这样做：/);
    assert.match(panel().querySelector('.dga-log-chips').textContent, /全部\d+错误1警告0信息\d+/, '等级按钮带条数');
    findButton(panel().querySelector('.dga-log-chips'), '错误').listeners.click[0]();
    assert.doesNotMatch(panel().querySelector('.dga-log-list').textContent, /甲一/, '只看错误');
    findButton(panel().querySelector('.dga-log-chips'), '全部').listeners.click[0]();
    const search = () => panel().querySelector('.dga-log-q');
    assert.ok(search(), '有关键词搜索框');
    search().listeners.change[0]({ target: { value: '甲一' } });
    assert.ok(!panel().querySelector('.dga-log-hint'), '搜索后只剩匹配的那条');
    assert.match(panel().textContent, /甲一 → 甲二/);
    findButton(panel(), '实时').listeners.click[0]();
    log.info('推进', '暂停期间来的');
    assert.match(panel().querySelector('.dga-live').textContent, /已暂停/, '暂停后按钮写着已暂停');
    assert.doesNotMatch(panel().textContent, /暂停期间来的/, '暂停时不显示新日志');
    findButton(panel(), '已暂停').listeners.click[0]();
    search().listeners.change[0]({ target: { value: '' } });
    assert.match(panel().textContent, /暂停期间来的/, '恢复后一次显示出来');
    assert.deepEqual(booted.errors, []);
});


// ---------------------------------------------------------------
// v2.14：规则语义对齐数据库（发送前过滤角色消息）+ 输出留痕 + 规则预览
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// 路线图（v4.0）：一棵树一个条目
// ---------------------------------------------------------------

// 搭一棵小树：开场 → 路口（留下 / 离开）；离开走完接回「重逢」；开场上挂一条支线。
function demoRoute(R) {
    const route = R.makeRoute('海边书店');
    const start = route.root;
    route.nodes[start].name = '开场';
    route.nodes[start].content = '开场正文';
    const fork = R.addNode(route, '路口', '路口正文', '');
    R.connect(route, start, fork, '');
    const stay = R.addNode(route, '留下', '留下正文', '');
    const leave = R.addNode(route, '离开', '离开正文', '');
    const meet = R.addNode(route, '重逢', '重逢正文', '');
    R.connect(route, fork, stay, '{{user}}留下');
    R.connect(route, fork, leave, '{{user}}离开');
    R.connect(route, stay, meet, '');
    R.connect(route, leave, meet, '');
    const side = R.addSide(route, start, '夏日祭', '{{char}}约{{user}}去祭典', '邀约');
    route.nodes[side.root].content = '邀约正文';
    const fireworks = R.addNode(route, '烟火', '烟火正文', '', side.id);
    R.connect(route, side.root, fireworks, '');
    return { route, start, fork, stay, leave, meet, side, fireworks };
}

test('路线图：一段一段往下走，到路口要选，走完接回同一段，走到终点什么都不发', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    const state = R.normalizeRouteState(null, t.route);
    assert.equal(state.cur, t.start, '新聊天从起点开始');
    assert.equal(R.mainStep(t.route, state).kind, 'moved');
    assert.equal(state.cur, t.fork);
    const atFork = R.mainStep(t.route, state);
    assert.equal(atFork.kind, 'pick', '路口要选一条');
    assert.equal(state.cur, t.fork, '没选之前停在路口');
    R.mainGo(t.route, state, t.leave);
    const cls = R.classify(t.route, state);
    assert.equal(cls[t.leave], 'cur');
    assert.equal(cls[t.stay], 'dead', '没走的路变灰');
    assert.equal(cls[t.meet], 'open', '接回的那段还能走到');
    assert.equal(R.mainStep(t.route, state).kind, 'moved');
    assert.equal(state.cur, t.meet, '走完接回「重逢」');
    assert.equal(R.mainStep(t.route, state).kind, 'ended', '后面什么都没接就是终点');
    assert.equal(R.compose(t.route, state), '', '走到终点什么都不发');
    assert.equal(R.mainBack(t.route, state), true);
    assert.equal(state.ended, false, '上一段先回到终点那一段');
    assert.equal(R.mainBack(t.route, state), true);
    assert.equal(state.cur, t.leave, '沿着实际走过的那一路往回退');
    assert.equal(R.jumpTo(t.route, state, t.stay), true);
    assert.deepEqual(plain(state.hist), [t.start, t.fork], '从这里接着走：补齐从起点过来的路');
});

test('路线图：支线和主线同时走，等它、主线到了某段就结束', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    const state = R.normalizeRouteState(null, t.route);
    assert.deepEqual(plain(R.offeredSides(t.route, state).map(side => side.name)), ['夏日祭'], '主线在挂支线的那段时可以开始');
    R.sideStart(t.route, state, t.side);
    assert.equal(R.compose(t.route, state), '开场正文', '没放支线格子时，模板只发主线');
    t.route.blocks.push({ id: 'k1', when: `side:${t.side.id}`, text: `祭典：⟦side:${t.side.id}⟧` });
    assert.equal(R.compose(t.route, state), '开场正文\n\n祭典：邀约正文', '支线开始以后和主线一起发');
    R.mainStep(t.route, state);
    assert.equal(state.cur, t.fork, '主线照常往下走');
    assert.equal(R.sideStep(t.route, state, t.side).kind, 'moved');
    assert.equal(R.compose(t.route, state), '路口正文\n\n祭典：烟火正文');
    assert.equal(R.sideStep(t.route, state, t.side).kind, 'ended', '支线走完自己的最后一段就结束');
    assert.equal(R.compose(t.route, state), '路口正文', '支线结束以后这一块不发');

    const waitCase = demoRoute(R);
    waitCase.side.wait = true;
    const waiting = R.normalizeRouteState(null, waitCase.route);
    R.sideStart(waitCase.route, waiting, waitCase.side);
    assert.equal(R.mainStep(waitCase.route, waiting).kind, 'wait', '设成等它时，主线停下来');
    assert.equal(waiting.cur, waitCase.start);

    const untilCase = demoRoute(R);
    untilCase.side.until = untilCase.fork;
    const until = R.normalizeRouteState(null, untilCase.route);
    R.sideStart(untilCase.route, until, untilCase.side);
    const step = R.mainStep(untilCase.route, until);
    assert.deepEqual(plain(step.closed.map(side => side.name)), ['夏日祭'], '主线到了那一段，支线没走完也结束');

    const skipCase = demoRoute(R);
    const skipped = R.normalizeRouteState(null, skipCase.route);
    R.mainStep(skipCase.route, skipped);
    assert.equal(R.classify(skipCase.route, skipped)[skipCase.side.root], 'dead', '主线离开那段还没开始，这条支线变灰');
    assert.equal(R.offeredSides(skipCase.route, skipped).length, 0);
});

test('路线图：分块模板一直发 / 走到某几段时发，空格子整行不发', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.blocks = [
        { id: 'a', when: 'always', text: '写作风格：慢节奏。\n\n现在：\n⟦main⟧' },
        { id: 'b', when: 'nodes', nodes: [t.fork], text: '信的内容：等这个夏天结束。' },
        { id: 'c', when: 'always', text: '⟦sides⟧' },
    ];
    const state = R.normalizeRouteState(null, t.route);
    assert.equal(R.compose(t.route, state), '写作风格：慢节奏。\n\n现在：\n开场正文', '支线没开始时「其余支线」那一行整行不发');
    R.mainStep(t.route, state);
    assert.match(R.compose(t.route, state), /信的内容/, '走到选中的段才发');
    R.sideStart(t.route, state, t.side);
    assert.match(R.compose(t.route, state), /夏日祭：邀约正文/, '没单独放格子的支线进「其余正在走的支线」');
    R.mainGo(t.route, state, t.stay);
    assert.doesNotMatch(R.compose(t.route, state), /信的内容/, '离开那几段就不发');
});

test('路线图：读回时清掉断掉的线和没用的块，顺序数字算在两条中间', () => {
    const R = load().core.routes;
    const route = R.normalizeRoute({
        id: 'tabc', name: '测试', root: 'n1',
        nodes: {
            n1: { id: 'n1', name: '一', next: [{ to: 'n2' }, { to: 'gone' }, { to: 'n2' }], fallback: 3 },
            n2: { id: 'n2', name: '二', next: [] },
            n9: { id: 'n9', name: '孤儿', next: [] },
        },
        sides: [{ id: 'sx', name: '没宿主', host: 'nope', root: 'n2' }],
        blocks: [{ id: 'k1', when: 'side:sx', text: '⟦side:sx⟧' }, { id: 'k2', when: 'nodes', nodes: ['n2', 'gone'], text: 'x' }],
    });
    assert.deepEqual(plain(route.nodes.n1.next), [{ to: 'n2', cond: '' }], '指向不存在的段、重复的线都去掉');
    assert.equal(route.nodes.n1.fallback, -1);
    assert.equal(route.nodes.n9, undefined, '走不到的段去掉');
    assert.equal(route.sides.length, 0, '宿主没了的支线去掉');
    assert.deepEqual(plain(route.blocks.map(block => block.id)), ['k2'], '支线没了，它那一块也去掉');
    assert.deepEqual(plain(route.blocks[0].nodes), ['n2']);
    const list = [
        { uid: 1, name: '人物', placement: { pos: 'after_character_definition', depth: 4, order: 100 } },
        { uid: 2, name: '地点', placement: { pos: 'after_character_definition', depth: 4, order: 200 } },
        { uid: 3, name: '我', isSelf: true, placement: { pos: 'after_character_definition', depth: 4, order: 999 } },
    ];
    assert.equal(R.orderAfter(list, { pos: 'after_character_definition' }, '1'), 150, '排在「人物」后面：取两条中间');
    assert.equal(R.orderAfter(list, { pos: 'after_character_definition' }, '2'), 210, '排在最后一条后面：多 10');
    assert.equal(R.orderAfter(list, { pos: 'after_character_definition' }, '__first__'), 90, '排在最前面');
    const at = order => ({ pos: 'before_character_definition', depth: 4, order });
    const tight = [
        { uid: 1, name: '元数据', placement: at(0) },
        { uid: 2, name: '运作设定', placement: at(1) },
        { uid: 3, name: '地点', placement: at(2) },
        { uid: 4, name: '人物', placement: at(10) },
    ];
    const before = { pos: 'before_character_definition' };
    assert.deepEqual(plain(R.makeRoom(tight, before, '1')), { order: 1, shifts: [{ uid: 2, order: 2 }, { uid: 3, order: 3 }] }, '顺序数字挨着：后面的往后挪，挪到有空位为止');
    assert.deepEqual(plain(R.makeRoom(tight, before, '__first__')), { order: 0, shifts: [{ uid: 1, order: 1 }, { uid: 2, order: 2 }, { uid: 3, order: 3 }] }, '最前面那条是 0：前面几条一起往后挪');
    assert.deepEqual(plain(R.makeRoom(tight, before, '3')), { order: 6, shifts: [] }, '有空位就取中间，不动别的');
    const tie = [1, 2, 3].map(uid => ({ uid, name: `同${uid}`, placement: at(100) }));
    assert.deepEqual(plain(R.makeRoom(tie, before, '1')), { order: 101, shifts: [{ uid: 2, order: 102 }, { uid: 3, order: 103 }] }, '顺序数字一样：照列出来的先后拉开');
    const ruled = R.normalizeRoute({
        ...plain(R.makeRoute('规则')),
        extractRules: [{ start: '<正文>', end: '' }, { start: ' ', end: '' }, 'x'],
        excludeRules: [{ start: '<thinking>', end: '</thinking>' }],
    });
    assert.deepEqual(plain(ruled.extractRules), [{ start: '<正文>', end: '' }], '填了一半的规则留着，空的和不是对象的丢掉');
    assert.deepEqual(plain(ruled.excludeRules), [{ start: '<thinking>', end: '</thinking>' }]);
    assert.deepEqual(plain(R.normalizeRoute(plain(R.makeRoute('没规则'))).excludeRules), [], '旧的路线图读回来没有规则');
});

function routeWorld() {
    const books = {
        书A: [
            { uid: 1, name: '人物设定', content: '人物', enabled: true, position: { type: 'after_character_definition', order: 100 }, strategy: { type: 'selective', keys: ['人物'], keys_secondary: { logic: 'and_any', keys: [] } } },
            { uid: 2, name: '地点', content: '地点', enabled: true, position: { type: 'after_character_definition', order: 200 } },
        ],
    };
    const world = multiWorld(books, {});
    world.helper.getCharData = () => ({ name: '测试角色', data: { name: '测试角色', extensions: { world: '书A' } } });
    return world;
}

test('路线图：世界书里一棵树只有一个条目，走一步换内容，位置和顺序不被盖掉', async () => {
    const world = routeWorld();
    const run = load(world.helper);
    await new Promise(setImmediate);
    const R = run.core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.placement = { pos: 'at_depth', depth: 2, role: 'system', order: 50 };
    await R.write([t.route]);
    await R.sync();
    const mine = () => world.state.books.书A.filter(item => item.name === '海边书店（动态指导）');
    assert.equal(mine().length, 1, '一棵树只建一个条目');
    assert.equal(world.state.books.书A.length, 3, '世界书里只多了这一个');
    assert.equal(mine()[0].content, '开场正文');
    assert.equal(mine()[0].enabled, true);
    assert.equal(mine()[0].strategy.type, 'constant', '一直发送，不靠关键词');
    assert.deepEqual(plain(mine()[0].strategy.keys), [], '不照抄模板条目的关键词');
    assert.deepEqual(plain(mine()[0].position), { type: 'at_depth', order: 50, depth: 2, role: 'system' }, '新建时用设好的位置');

    const state = R.normalizeRouteState(null, t.route);
    R.mainStep(t.route, state);
    await R.writeState(t.route.id, state);
    await R.sync();
    assert.equal(mine()[0].content, '路口正文', '走一步，条目内容跟着换');

    mine()[0].position = { type: 'before_character_definition', order: 7 };
    await R.sync();
    assert.deepEqual(plain(mine()[0].position), { type: 'before_character_definition', order: 7 }, '用户在世界书里改的位置不盖掉');
    const saved = (await R.read())[0];
    assert.equal(saved.placement.pos, 'before_character_definition', '读回来记下');
    assert.equal(saved.placement.order, 7);

    saved.name = '海边书店·夏';
    await R.write([saved]);
    await R.sync();
    assert.equal(mine().length, 0);
    assert.equal(world.state.books.书A.filter(item => item.name === '海边书店·夏（动态指导）').length, 1, '改名时条目跟着改名，不另建');

    await R.setPlacement(saved, { pos: 'after_character_definition', order: 150 });
    const renamed = world.state.books.书A.find(item => item.name === '海边书店·夏（动态指导）');
    assert.equal(renamed.position.type, 'after_character_definition');
    assert.equal(renamed.position.order, 150, '在助手里改位置会写进世界书');

    const finished = R.normalizeRouteState(null, saved);
    R.jumpTo(saved, finished, t.meet);
    R.mainStep(saved, finished);
    await R.writeState(saved.id, finished);
    await R.sync();
    assert.equal(renamed.enabled, false, '走到终点，条目关掉');
    assert.equal(renamed.content, '');
    assert.equal(world.state.books.书A.length, 3, '条目留着，位置和顺序还在');
    assert.deepEqual(run.errors, []);
});

test('路线图：条目名带「（动态指导）」也不会被当成旧镜像重建绑定；总开关关掉时条目关掉', async () => {
    const world = routeWorld();
    world.state.books.书A.push({ uid: 3, name: '海边书店', content: '## 一\n正文', enabled: true });
    const run = load(world.helper);
    await new Promise(setImmediate);
    const R = run.core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    await R.write([t.route]);
    await R.sync();
    await world.state.events.get('chat_changed')();
    await new Promise(setImmediate);
    assert.equal(world.state.variables.character.$dynamicGuideAssistant.config.bindings.length, 0, '路线图条目不能被认成「海边书店」的镜像');
    world.state.variables.character.$dynamicGuideAssistant.config.settings = { guideEnabled: false };
    await world.state.events.get('generate')('normal');
    const entry = world.state.books.书A.find(item => item.name === '海边书店（动态指导）');
    assert.equal(entry.enabled, false, '总开关关掉，路线图条目也关掉');
    world.state.variables.character.$dynamicGuideAssistant.config.settings = { guideEnabled: true };
    await world.state.events.get('generate')('normal');
    assert.equal(entry.enabled, true, '重新打开后照常发');
    assert.deepEqual(run.errors, []);
});

test('路线图：打开面板就是选中的那棵树，主线一行、支线一行，点下一段会走', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    world.helper.getWorldbookNames = () => ['书A'];
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const card = panel().querySelector(`.dga-rt-card-${t.route.id}`);
    assert.ok(card, '打开面板直接是这棵树');
    assert.match(card.textContent, /海边书店/);
    assert.ok(card.querySelector('.dga-rt-svg'), '卡里画出路线图');
    assert.match(card.querySelector('.dga-rt-rows').textContent, /主线.*开场/, '主线一行写着现在在哪');
    assert.match(card.querySelector('.dga-rt-rows').textContent, /可以开始.*夏日祭/, '挂在这段的支线可以开始');
    findButton(card, '下一段').listeners.click[0]();
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
    const after = panel().querySelector(`.dga-rt-card-${t.route.id}`);
    assert.match(after.querySelector('.dga-rt-rows').textContent, /现在：路口/, '点下一段走到路口');
    const saved = world.state.variables.chat.$dynamicGuideAssistant.routeState.routes[t.route.id];
    assert.equal(saved.cur, t.fork, '进度存进聊天变量');
    assert.match(documentRef.getElementById('dynamic-guide-assistant-style').textContent, /\.dga-rt-drawer \{/, '带上路线图的样式');
    assert.deepEqual(errors, []);
});

test('路线图：左栏是标志和总开关、路线图列表、API / 运行日志 / 设置', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const a = demoRoute(R);
    const b = R.makeRoute('高二上学期');
    a.route.worldbookName = '书A';
    b.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(a.route), plain(b)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const rail = () => panel().querySelector('.dga-rail');
    assert.ok(rail().querySelector('.dga-rail-toggle'), '标志那一行带总开关');
    assert.match(rail().querySelector('.dga-rail-state').textContent, /指导中/);
    const trees = rail().querySelector('.dga-rail-trees');
    assert.equal(trees.children.length, 2, '每棵树一行');
    assert.match(trees.textContent, /海边书店开场/, '名字下面只写现在在哪一段');
    assert.doesNotMatch(trees.textContent, /条支线在走/, '不写「几条支线在走」');
    assert.equal(rail().querySelector('.dga-rail-pulse'), null, '左边不放圆点');
    assert.doesNotMatch(rail().textContent, /仪表盘|开发者模式|动态指导(?!助手)/);
    findButton(trees, '高二上学期').listeners.click[0]();
    assert.ok(panel().querySelector(`.dga-rt-card-${b.id}`), '点哪棵右边就显示哪棵');
    assert.equal(panel().querySelector(`.dga-rt-card-${a.route.id}`), null, '右边一次只放一棵');
    findButton(rail(), '设置').listeners.click[0]();
    const settingsText = panel().querySelector('.dga-body').textContent;
    assert.match(settingsText, /往下走.*AI 判断.*多久问一次.*给它看几段回复.*流式输出.*判断提示词/, '设置页：往下走、AI 判断、判断提示词');
    assert.doesNotMatch(settingsText, /大检查|推进冷却|开发者模式|外观|配色/, '用不上的设置都去掉了');
    assert.match(settingsText, /在最上面加一段.*在最下面加一段/, '提示词段最上面和最下面都能加一段');
    findButton(rail(), 'API').listeners.click[0]();
    assert.match(panel().querySelector('.dga-head').textContent, /API/);
    assert.match(panel().querySelector('.dga-body').textContent, /预设名称.*连接方式.*酒馆主 API.*自定义/, 'API 页照数据库：预设名称、连接方式');
    assert.deepEqual(errors, []);
});

test('路线图：卡片标题栏是编辑路线 / 位置和顺序 / 发给 AI 的内容 / 设置，往下走在设置里', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const card = () => panel().querySelector(`.dga-rt-card-${t.route.id}`);
    const head = card().querySelector('.dga-rt-head');
    assert.match(head.textContent, /编辑路线.*位置和顺序.*发给 AI 的内容.*设置/);
    assert.doesNotMatch(card().textContent, /往下走|现在检查|上次（第/, '卡片上没有往下走那一行');
    assert.match(card().querySelector('.dga-rt-rows').textContent, /可以开始支线 · 夏日祭进入条件/, '进入条件写在支线名后面');
    assert.ok(card().querySelector('.dga-rt-zoomf'), '缩放在图的右下角');
    findButton(head, '设置').listeners.click[0]();
    const drawer = () => panel().querySelector('.dga-rt-drawer');
    assert.match(drawer().textContent, /往下走.*删掉这张路线图/);
    assert.doesNotMatch(drawer().textContent, /判断用的 API/, '没选 AI 判断时不出现 AI 判断那一组');
    assert.ok(!drawer().classList.contains('is-shown'), '刚打开时播一次滑入');
    findButton(drawer(), 'AI 判断').listeners.click[0]();
    assert.ok(drawer().classList.contains('is-shown'), '开着时点按钮重画，不再播滑入（不闪）');
    assert.match(drawer().textContent, /判断用的 API.*跟随当前活动API.*判断提示词/, '选了 AI 判断才出现');
    assert.match(drawer().textContent, /判断提示词.*提取 \/ 排除规则.*删掉这张路线图/, '提取 / 排除规则在 AI 判断下面、删除上面');
    assert.equal(findAllClass(drawer(), 'dga-rs-rule').length, 0, '没有规则时不列空行');
    findButton(drawer(), '＋ 加一条').listeners.click[0]();
    assert.equal(findAllClass(drawer(), 'dga-rs-rule').length, 1, '点「加一条」多一行开始 / 结束');
    findButton(card().querySelector('.dga-rt-head'), '编辑路线').listeners.click[0]();
    assert.match(card().querySelector('.dga-rt-head').textContent, /完成编辑/);
    assert.deepEqual(errors, []);
});

test('路线图：位置和顺序不列数据库和 MVU 的条目；放到顺序数字一样的两条中间，后面的往后挪', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const after = order => ({ type: 'after_character_definition', order });
    world.state.books.书A.push(
        { uid: 3, name: 'TavernDB-ACU-ReadableDataTable', content: '表', enabled: true, position: after(150) },
        { uid: 4, name: '[InitVar]初始化变量', content: '{}', enabled: false, position: after(150) },
        { uid: 5, name: '天气', content: '晴', enabled: true, position: after(200) },
        { uid: 6, name: '时间', content: '夏', enabled: true, position: after(201) },
    );
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.placement = { ...t.route.placement, pos: 'before_character_definition' };
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    findButton(panel().querySelector(`.dga-rt-card-${t.route.id}`).querySelector('.dga-rt-head'), '位置和顺序').listeners.click[0]();
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    const drawer = panel().querySelector('.dga-rt-drawer');
    assert.doesNotMatch(drawer.textContent, /TavernDB|InitVar/, '数据库和 MVU 的条目不列');
    const group = findAllClass(drawer, 'dga-rt-order-group').find(node => /角色定义后/.test(node.textContent));
    assert.match(group.textContent, /人物设定.*地点.*天气.*时间/);
    const slots = findAllClass(group, 'dga-rt-slot');
    assert.equal(slots.length, 5, '每两条中间都能放');
    slots[2].listeners.click[0]();
    for (let i = 0; i < 8; i += 1) await new Promise(setImmediate);
    const order = name => {
        const entry = world.state.books.书A.find(item => item.name === name);
        return entry.position.order;
    };
    assert.equal(order('地点'), 200, '前面的不动');
    assert.equal(order('天气'), 202, '和「地点」一样是 200 的「天气」往后挪');
    assert.equal(order('时间'), 203, '后面挨着的也跟着挪，先后不变');
    assert.equal(order('TavernDB-ACU-ReadableDataTable'), 150, '数据库条目不碰');
    assert.deepEqual(errors, []);
});

function memoryStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
        get length() { return data.size; },
        key: index => Array.from(data.keys())[index] || null,
    };
}

test('路线图：判断提示词按段发，格子换成当时的内容；关掉的段不发，没放作答表自动补上', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    const state = R.normalizeRouteState(null, t.route);
    R.mainStep(t.route, state);
    const item = R.judgeCase(t.route, state);
    const host = { char: '书店老板', persona: '打工的学生', substitute: text => text.replace(/\{\{user\}\}/g, '小林') };
    const messages = plain(R.judgeMessages(t.route, item, '两人在整理旧书。', R.defaultPrompt(), host));
    assert.equal(messages.length, 7, '默认提示词 7 段');
    assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'system', 'system', 'assistant', 'user'], '最后一段是 USER');
    const all = messages.map(m => m.content).join('\n');
    assert.match(all, /路线图：海边书店/);
    assert.match(all, /现在这一段：路口[\s\S]*1\. 留下：小林留下[\s\S]*2\. 离开：小林离开/, '在走的线写出路口的几条路，酒馆宏换成名字');
    assert.match(all, /两人在整理旧书。/);
    assert.match(all, /<answer n="1">[\s\S]*<road>/, '作答表在路口要问走哪条');
    assert.doesNotMatch(all, /\{\{(路线图|在走的线|可以开始的支线|最近正文|作答表)\}\}/, '格子都换掉了');

    const custom = [
        { role: 'system', content: '角色：{{角色设定}}；用户：{{用户设定}}' },
        { role: 'system', content: '这一段不发', enabled: false },
        { role: 'user', content: '正文：{{最近正文}}' },
    ];
    const sent = plain(R.judgeMessages(t.route, item, '正文 $& 原样', custom, host));
    assert.equal(sent.length, 2, '关掉的段不发');
    assert.equal(sent[0].content, '角色：书店老板；用户：打工的学生');
    assert.match(sent[1].content, /^正文：正文 \$& 原样/, '正文里的 $& 按字面放');
    assert.match(sent[1].content, /## 作答表\n每条线一个 <answer>/, '没放作答表，补在最后一段 USER 末尾');
});

test('路线图：判断提示词预设——默认排第一，改过的默认和自己建的从配置里读', () => {
    const R = load().core.routes;
    assert.deepEqual(plain(R.promptPresets({}).map(item => item.name)), ['默认']);
    const list = R.promptPresets({ routePromptPresets: [
        { name: '简短', segments: [{ role: 'user', content: '{{作答表}}' }] },
        { name: '默认', segments: [{ role: 'SYSTEM', content: '改过的默认' }] },
        { name: '空的', segments: [] },
    ] });
    assert.deepEqual(plain(list.map(item => item.name)), ['默认', '简短'], '默认排第一，没有段的丢掉');
    assert.equal(list[0].segments[0].role, 'system', '角色统一小写');
    assert.equal(list[0].segments[0].content, '改过的默认');
});

test('路线图：AI 判断按这张图自己选的 API 和提示词发，结论落到进度上', async () => {
    const world = routeWorld();
    world.state.messages = [{ message_id: 4, role: 'assistant', message: '<thinking>先想想怎么写</thinking>小林决定离开小镇，提着箱子去了码头。' }];
    world.state.lastMessageId = 4;
    const storage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{ name: '便宜的', connection: 'custom', customApiFormat: 'openai_compat', apiurl: 'https://api.example.com/v1', key: 'k', model: 'm-small' }]),
    });
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, body: JSON.parse(options.body) });
        const content = '<thinking>草稿</thinking><judge_plan>对上了</judge_plan><answer n="1"><basis>写了离开</basis><done>YES</done><road>2</road></answer><start>0</start>';
        const text = JSON.stringify({ choices: [{ message: { content } }] });
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    };
    const run = load(world.helper, { localStorage: storage, fetch: fetchMock });
    await new Promise(setImmediate);
    const R = run.core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.advance = 'judge';
    t.route.prompt = '简短';
    t.route.excludeRules = [{ start: '<thinking>', end: '</thinking>' }];
    world.state.variables.character.$dynamicGuideAssistant.config.settings = {
        routePromptPresets: [{ name: '简短', segments: [{ role: 'system', content: '只看正文' }, { role: 'user', content: '{{最近正文}}\n{{作答表}}' }] }],
        // 旧版设置里的全局规则不再用：要是还用，下面「小林决定离开小镇」会被删掉。
        excludeRules: [{ start: '小林', end: '码头' }],
    };
    await R.write([t.route]);
    const state = R.normalizeRouteState(null, t.route);
    R.mainStep(t.route, state);
    await R.writeState(t.route.id, state);
    R.setApi(t.route, '便宜的');
    assert.equal(R.apiName(t.route), '便宜的', '这张图选的 API 存在本机');
    const moved = await R.judge(t.route, 4);
    assert.equal(moved, true);
    assert.equal(fetches.length, 1, '走自定义 API');
    assert.equal(fetches[0].body.model, 'm-small');
    assert.equal(fetches[0].body.messages[0].content, '只看正文', '用这张图选的那套提示词');
    assert.match(fetches[0].body.messages[1].content, /小林决定离开小镇/);
    assert.doesNotMatch(fetches[0].body.messages[1].content, /先想想/, '这张图的排除规则作用在发出去的正文上');
    assert.doesNotMatch(run.core.getJudgeRuntime().lastFiltered, /草稿/, '也作用在判断 AI 的回答上');
    const saved = (await R.readStates())[t.route.id];
    assert.equal(saved.cur, t.leave, '路口按 <road>2</road> 走了「离开」');
    assert.deepEqual(run.errors, []);
});

test('自定义 API 请求体对照数据库：带 top_p，TauriTavern 带 custom_api_format，流式时合并 stream_options', () => {
    const preset = { name: 'c', connection: 'custom', customApiFormat: 'claude_messages', apiurl: 'https://api.anthropic.com', key: 'sk', model: 'claude', maxTokens: 100, temperature: 0.5, bodyParams: '{"top_k":50}' };
    const plainBody = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset, false);
    assert.equal(plainBody.top_p, 0.95);
    assert.equal(plainBody.chat_completion_source, 'claude', '原版酒馆：Claude 走原生协议源');
    assert.equal('custom_api_format' in plainBody, false);
    assert.equal(plainBody.custom_include_body, '{"top_k":50}', '不流式时用户写的原样交给酒馆');
    const streamBody = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset, true);
    assert.deepEqual(JSON.parse(streamBody.custom_include_body), { top_k: 50, stream_options: { include_usage: true } }, '流式时加上 include_usage');
    const yamlBody = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], { ...preset, bodyParams: 'top_k: 50' }, true);
    assert.equal(yamlBody.custom_include_body, 'top_k: 50', '用户写的 YAML 不改');
    const tauri = load(null, { __TAURITAVERN__: {} });
    const tauriBody = tauri.core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset, false);
    assert.equal(tauriBody.chat_completion_source, 'custom', 'TauriTavern 下一律 custom');
    assert.equal(tauriBody.custom_api_format, 'claude_messages');
});

test('路线图：旧版绑定不再支持，启动时停用——原条目重新打开、旧镜像删掉、绑定清空', async () => {
    const world = routeWorld();
    world.state.books.书A.push(
        { uid: 5, name: '旧大纲', content: '## 一\n正文', enabled: false },
        { uid: 6, name: '旧大纲（动态指导）', content: '一', enabled: true },
    );
    world.state.variables.character.$dynamicGuideAssistant.config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 5, entryName: '旧大纲' }],
    };
    const run = load(world.helper);
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
    assert.equal(world.state.variables.character.$dynamicGuideAssistant.config.bindings.length, 0, '绑定清空');
    assert.equal(world.state.books.书A.find(item => item.uid === 5).enabled, true, '原条目重新打开');
    assert.equal(world.state.books.书A.some(item => item.name === '旧大纲（动态指导）'), false, '旧镜像删掉');
    assert.equal(world.state.books.书A.find(item => item.uid === 5).content, '## 一\n正文', '正文一个字不动');
    assert.deepEqual(run.errors, []);
});
