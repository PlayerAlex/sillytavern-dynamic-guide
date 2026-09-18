'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function load(helper) {
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
    };
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

function runtime(entry) {
    const events = new Map();
    const injected = [];
    const removed = [];
    const variables = {
        character: { $dynamicGuideAssistant: { config: { worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' } } },
        chat: {},
    };
    let entries = [entry];
    const helper = {
        tavern_events: { GENERATION_AFTER_COMMANDS: 'generate' },
        eventOn: (event, listener) => events.set(event, listener),
        getVariables: ({ type }) => variables[type],
        updateVariablesWith: (updater, { type }) => { variables[type] = updater(variables[type]); },
        getWorldbook: () => entries,
        updateWorldbookWith: (_name, updater) => { entries = updater(entries); },
        injectPrompts: prompts => injected.push(...prompts),
        uninjectPrompts: ids => removed.push(...ids),
    };
    return { ...load(helper), injected, removed, generate: async () => { events.get('generate')('normal', {}, false); await new Promise(setImmediate); } };
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
        assert.deepEqual(run.removed, ['dynamic-guide-assistant-current']);
        assert.match(run.logs.join('\n'), /转换成新版格式/);
        assert.deepEqual(run.errors, []);
    });
}

test('新格式仍正常注入且重新禁用意外启用的来源条目', async () => {
    const entry = { uid: 1, name: '大纲', content: '## 第一幕\n当前正文\n\n## 第二幕\n未来秘密', enabled: true };
    const run = runtime(entry);
    await run.generate();
    assert.equal(run.injected.length, 1);
    assert.match(run.injected[0].content, /当前正文/);
    assert.doesNotMatch(run.injected[0].content, /未来秘密/);
    assert.equal(entry.enabled, false);
    assert.deepEqual(run.errors, []);
});
