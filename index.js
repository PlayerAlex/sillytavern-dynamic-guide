(function () {
    'use strict';

    /* ================================================================
     * 动态指导助手 v2.3
     *
     * 这个文件分三部分：
     *   一、核心：纯函数。把世界书正文解析成阶段，按进度挑出要发的内容，
     *       拼成注入文本；选区划分也在这里做载入和重建。不碰页面，
     *       不碰酒馆接口，可以单独测试。
     *   二、适配层：读写酒馆助手的变量、世界书、注入和事件。
     *   三、界面：管理页和“划分阶段”编辑器（看分段 / 选区划分 / 编辑原文）。
     *
     * 可以同时绑定好几个大纲条目：每个条目被关闭后，只有当前阶段的切片
     * 会注入回它原来的位置，相当于暂时让其余内容不被 AI 看到。
     *
     * 数据只存两处：
     *   - 阶段结构就是世界书条目正文本身，用标题行（## 名称）分段。
     *   - 绑定列表存在角色变量里；每个绑定的进度按绑定分开存在聊天变量里。
     * ================================================================ */

    // ---------------------------------------------------------------
    // 一、核心：常量与文本工具
    // ---------------------------------------------------------------

    const SCRIPT_NAME = '动态指导助手';
    const VERSION = '2.3';
    const VARIABLE_ROOT = '$dynamicGuideAssistant';
    const INJECTION_ID = 'dynamic-guide-assistant-current';
    const INSTANCE_KEY = '__dynamicGuideAssistantInstance';
    const UI_PREFIX = 'dynamic-guide-assistant';
    const PANEL_ID = `${UI_PREFIX}-panel`;
    const STYLE_ID = `${UI_PREFIX}-style`;
    const MENU_ITEM_ID = `${UI_PREFIX}-menu-item`;
    const LEGACY_MENU_CONTAINER_ID = `${UI_PREFIX}-menu-container`;
    const COMPLETE_MARKER_RE = /<!--\s*DGA_COMPLETE:([a-z0-9_-]+)\s*-->/gi;

    const STAGE_COLORS = ['#8b5cf6', '#3b82f6', '#14b8a6', '#f59e0b', '#ef4444', '#ec4899', '#84cc16', '#06b6d4'];
    const KIND_COLORS = { addon: '#9ca3af', always: '#0ea5e9', note: '#6b7280', merged: '#a78bfa' };
    const KIND_LABELS = { stage: '剧情阶段', addon: '附加内容', always: '常驻', note: '备注', merged: '并入已有阶段' };
    const TAG_BY_KIND = { addon: '附加', always: '常驻', note: '备注' };
    const LABEL_TEXT_BY_KEY = { from: '从', to: '到', merge: '合并到' };
    const KIND_BY_TAG = {
        '附加': 'addon', '附加内容': 'addon', '物品': 'addon',
        '常驻': 'always', '常驻提示': 'always',
        '备注': 'note', '不发送': 'note', '注释': 'note',
    };

    function normalizeText(text) {
        return String(text == null ? '' : text)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n?/g, '\n');
    }

    function hashText(text) {
        let hash = 2166136261;
        const source = String(text || '');
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function squash(text) {
        return String(text == null ? '' : text).replace(/\s+/g, '').toLowerCase();
    }

    function oneLine(text) {
        return String(text == null ? '' : text).replace(/\s*\n\s*/g, ' ').trim();
    }

    // ---------------------------------------------------------------
    // 一、核心：识别标题行和标签行
    //
    // 标题行有两种写法：`## 名称` 或 `【名称】`（旧模板的 `【内容：名称】` 也认）。
    // 标题末尾可以带 [附加] / [常驻] / [备注]，不带就是剧情阶段。
    // 标题下面可以跟几行“标签”：
    //   完成：xxx     剧情阶段什么时候算完成（留空 = 只能手动点“下一段”）
    //   从：阶段名    附加内容从哪一段开始有效（默认：它所在的那一段）
    //   到：阶段名    附加内容到哪一段为止（默认：和“从”相同）
    //   合并到：阶段名 把这段文字并进已有的阶段，一个阶段就能吃掉好几段正文
    // ---------------------------------------------------------------

    const MD_HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
    const BRACKET_HEADING_RE = /^\s*【\s*(?:(?:内容|剧情|阶段|指导|章节)\s*[：:]\s*)?([^【】\n]+?)\s*】\s*$/;
    const TRAILING_TAG_RE = /\s*[\[［(（]\s*([^\[\]［］()（）\s]{1,6})\s*[\]］)）]\s*$/;
    const LABEL_RE = /^\s*([^\s：:【】\[\]#]{1,10})\s*[：:]\s*(.*)$/;
    const LABEL_WORDS = {
        completion: ['完成', '完成条件', '什么时候完成', '结束条件', '进入下一阶段', '下一阶段', '什么时候进入下一阶段'],
        from: ['从', '开始于', '什么时候出现', '出现时机', '出现条件', '开始条件', '触发时机'],
        to: ['到', '直到', '结束于', '什么时候消失', '消失时机', '消失条件'],
        merge: ['合并到', '并入', '归入', '归属到', '追加到', '属于', '归到'],
        type: ['类型', '内容类型', '分类'],
        prompt: ['告诉ai', '提示词', '指导内容', '发送给ai', '让ai知道'],
    };

    function parseHeadingLine(line) {
        let rest = String(line == null ? '' : line);
        let kind = 'stage';
        for (;;) {
            const match = rest.match(TRAILING_TAG_RE);
            if (!match || !KIND_BY_TAG[match[1]]) break;
            kind = KIND_BY_TAG[match[1]];
            rest = rest.slice(0, match.index);
        }
        const markdown = rest.match(MD_HEADING_RE);
        const bracket = markdown ? null : rest.match(BRACKET_HEADING_RE);
        if (!markdown && !bracket) return null;
        const name = (markdown ? markdown[1] : bracket[1]).trim();
        return name ? { name, kind } : null;
    }

    function parseLabelLine(line) {
        const match = String(line == null ? '' : line).match(LABEL_RE);
        if (!match) return null;
        const word = squash(match[1]);
        const key = Object.keys(LABEL_WORDS).find(item => LABEL_WORDS[item].includes(word));
        return key ? { key, value: match[2].trim() } : null;
    }

    // 行首反斜杠让标题/标签保持为正文；双反斜杠保留原有反斜杠。
    function unescapeBodyLine(line) {
        const match = String(line).match(/^(\s*)\\(.*)$/);
        if (!match) return null;
        const rest = match[2];
        return rest.startsWith('\\') || parseHeadingLine(rest) || parseLabelLine(rest)
            ? match[1] + rest : null;
    }

    function escapeBodyText(text) {
        return normalizeText(text).split('\n').map(line => {
            if (!parseHeadingLine(line) && !parseLabelLine(line) && !/^\s*\\/.test(line)) return line;
            return line.replace(/^(\s*)/, '$1\\');
        }).join('\n');
    }

    function resolveStageRef(value, stages) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return -1;
        const quoted = raw.match(/[《「“"『]([^》」”"』]+)[》」”"』]/);
        const wanted = squash(quoted ? quoted[1] : raw);
        const byName = stages.findIndex(stage => squash(stage.name) === wanted);
        if (byName >= 0) return byName;
        const numbered = raw.match(/^第?\s*(\d+)\s*(?:段|章|节|阶段)?$/);
        if (numbered && stages[Number(numbered[1]) - 1]) return Number(numbered[1]) - 1;
        return -1;
    }

    // ---------------------------------------------------------------
    // 一、核心：把正文解析成阶段
    // ---------------------------------------------------------------

    function parseOutline(input) {
        const text = normalizeText(input);
        const lines = text.split('\n');
        const blocks = [];
        const items = [];
        const warnings = [];
        let block = null;
        let paragraph = null;
        // 标签后面空着时（例如旧模板的“什么时候消失：”单独一行），值写在接下来几行里
        let openLabel = null;

        const closeParagraph = () => {
            if (!paragraph) return;
            items.push(paragraph);
            if (paragraph.block) paragraph.block.paragraphs.push(paragraph);
            paragraph = null;
        };

        lines.forEach((line, index) => {
            const escaped = unescapeBodyLine(line);
            const heading = escaped == null ? parseHeadingLine(line) : null;
            if (heading) {
                closeParagraph();
                openLabel = null;
                if (block) block.end = index;
                block = {
                    kind: heading.kind,
                    name: heading.name,
                    headingLine: index,
                    labelLines: [],
                    labels: {},
                    paragraphs: [],
                    start: index,
                    end: lines.length,
                };
                blocks.push(block);
                items.push({ kind: 'heading', block, line: index });
                return;
            }
            if (!line.trim()) {
                closeParagraph();
                openLabel = null;
                return;
            }
            const label = block && escaped == null ? parseLabelLine(line) : null;
            if (label && !(label.key === 'prompt' && label.value)) {
                closeParagraph();
                block.labelLines.push(index);
                if (label.key === 'prompt') {
                    openLabel = null;
                } else {
                    if (!block.labels[label.key]) block.labels[label.key] = label.value;
                    openLabel = label.value ? null : label.key;
                }
                return;
            }
            if (openLabel && !label && escaped == null) {
                block.labelLines.push(index);
                block.labels[openLabel] = [block.labels[openLabel], line.trim()].filter(Boolean).join(' ');
                return;
            }
            openLabel = null;
            const content = escaped != null ? escaped : (label ? label.value : line);
            if (!paragraph) {
                paragraph = { kind: 'paragraph', block, start: index, end: index + 1, lines: [content] };
            } else {
                paragraph.end = index + 1;
                paragraph.lines.push(content);
            }
        });
        closeParagraph();

        blocks.forEach(item => {
            // 旧模板用“类型：重要物品”这类写法表示附加内容
            if (item.kind === 'stage' && item.labels.type && !/主线|剧情|阶段|章节/.test(item.labels.type)) {
                item.kind = 'addon';
            }
            item.prompt = item.paragraphs
                .map(part => part.lines.join('\n').trim())
                .filter(Boolean)
                .join('\n\n');
        });

        // “合并到：阶段名”能让一段文字并进已有的阶段，于是一个阶段可以由
        // 几段不连续的文字组成，不需要靠选区，也不需要额外存一份数据。
        const stageCandidates = blocks.filter(item => item.kind === 'stage');
        blocks.forEach(item => {
            const ref = item.labels.merge;
            if (!ref) return;
            const target = resolveStageRef(ref, stageCandidates);
            if (target < 0) {
                warnings.push(`“${item.name}”写的“合并到：${ref}”找不到同名阶段，已按独立阶段处理。`);
                return;
            }
            item.kind = 'merged';
            item.mergeInto = target;
        });

        const stages = [];
        blocks.forEach(item => {
            if (item.kind === 'stage') {
                item.stageIndex = stages.length;
                item.anchorStage = stages.length;
                item.id = `stage-${stages.length + 1}-${hashText(item.name).slice(0, 6)}`;
                item.color = STAGE_COLORS[stages.length % STAGE_COLORS.length];
                // 旧模板的“什么时候消失”对剧情阶段来说就是完成条件
                item.completion = String(item.labels.completion || item.labels.to || '').trim();
                stages.push(item);
            } else {
                item.anchorStage = Math.max(0, stages.length - 1);
                item.color = KIND_COLORS[item.kind];
            }
        });

        // 常驻块写在所有阶段之前时，注入里也排在当前阶段内容之前（“在上面”）；
        // 写在阶段之间或最后则排在附加内容区（“在下面”）。
        blocks.forEach(item => {
            if (item.kind === 'always') {
                item.aboveStages = stages.length > 0 && item.headingLine < stages[0].headingLine;
            }
        });

        blocks.forEach(item => {
            if (item.kind !== 'merged') return;
            const stage = stages[item.mergeInto];
            if (!stage) return;
            stage.prompt = [stage.prompt, item.prompt].filter(Boolean).join('\n\n');
            item.anchorStage = stage.stageIndex;
            item.color = KIND_COLORS.merged;
        });

        const addons = [];
        blocks.forEach(item => {
            if (item.kind === 'always') {
                item.fromIndex = 0;
                item.toIndex = Number.POSITIVE_INFINITY;
                addons.push(item);
                return;
            }
            if (item.kind !== 'addon') return;
            const from = resolveStageRef(item.labels.from, stages);
            const to = resolveStageRef(item.labels.to, stages);
            if (item.labels.from && from < 0) {
                warnings.push(`“${item.name}”写的“从：${item.labels.from}”找不到同名阶段，已改成从它所在的阶段开始。`);
            }
            if (item.labels.to && to < 0) {
                warnings.push(`“${item.name}”写的“到：${item.labels.to}”找不到同名阶段，已改成和开始阶段相同。`);
            }
            item.fromIndex = from >= 0 ? from : item.anchorStage;
            item.toIndex = to >= 0 ? to : item.fromIndex;
            if (item.toIndex < item.fromIndex) {
                warnings.push(`“${item.name}”的结束阶段排在开始阶段前面，已按只在开始阶段有效处理。`);
                item.toIndex = item.fromIndex;
            }
            addons.push(item);
        });

        blocks.forEach(item => {
            if (item.kind !== 'note' && !item.prompt) {
                warnings.push(`“${item.name}”下面没有文字，这一段不会发送任何内容。`);
            }
        });
        if (stages.length === 0) {
            warnings.push(blocks.length > 0
                ? '没有剧情阶段：所有标题都被标成了附加、常驻或备注。'
                : '还没有分阶段。打开“划分阶段”，点一个段落把它设为第一阶段的开头。');
        }

        return { text, lines, blocks, items, stages, addons, warnings };
    }

    function activeAddons(parsed, stageIndex) {
        if (!parsed || stageIndex < 0 || stageIndex >= parsed.stages.length) return [];
        return parsed.addons.filter(item => stageIndex >= item.fromIndex && stageIndex <= item.toIndex && item.prompt);
    }

    function formatInjection(stage, addons) {
        if (!stage) return '';
        // 写在所有阶段之前的常驻排在最前面，其余附加/常驻按正文顺序放在阶段之后。
        const above = addons.filter(item => item.kind === 'always' && item.aboveStages);
        const below = addons.filter(item => !above.includes(item));
        const lines = [
            '[动态指导助手：当前有效内容]',
            '以下是作者为当前进度准备的内部创作指导。自然地遵守它，不要向用户提及指导系统、阶段、完成判定或隐藏标记。',
        ];
        if (above.length > 0) {
            lines.push('', '## 常驻提示');
            above.forEach(item => lines.push('', `### ${item.name}`, item.prompt));
        }
        lines.push('', `## 当前阶段：${stage.name}`, stage.prompt);
        if (below.length > 0) {
            lines.push('', '## 同时有效的附加内容');
            below.forEach(item => lines.push('', `### ${item.name}`, item.prompt));
        }
        if (stage.completion) {
            lines.push(
                '',
                '## 当前阶段的完成判定',
                stage.completion,
                '',
                '只有当你确信本次回复已经实际完成上述判定时，才在回复末尾原样附加下面这行 HTML 注释；尚未完成时不要附加：',
                `<!-- DGA_COMPLETE:${stage.id} -->`,
            );
        }
        return lines.join('\n');
    }

    function reconcileState(rawState, parsed) {
        const old = rawState && typeof rawState === 'object' ? rawState : {};
        // 兼容 1.x 的字段名 mainIndex / mainName
        const oldIndex = Number.isInteger(old.stageIndex) ? old.stageIndex
            : (Number.isInteger(old.mainIndex) ? old.mainIndex : 0);
        const oldName = old.stageName || old.mainName || '';
        let index = oldIndex;
        if (oldName) {
            const byName = parsed.stages.findIndex(stage => stage.name === oldName);
            if (byName >= 0) index = byName;
        }
        index = Math.max(0, Math.min(index, parsed.stages.length));
        return {
            stageIndex: index,
            stageName: parsed.stages[index] ? parsed.stages[index].name : '',
            lastCompletionMessageId: old.lastCompletionMessageId == null ? null : old.lastCompletionMessageId,
            lastCompletionFingerprint: old.lastCompletionFingerprint || '',
            updatedAt: old.updatedAt || new Date().toISOString(),
        };
    }

    // ---------------------------------------------------------------
    // 一、核心：编辑器对正文做的几种改动（只增删标题行和标签行）
    // ---------------------------------------------------------------

    function headingText(spec) {
        const tag = TAG_BY_KIND[spec.kind];
        return `## ${String(spec.name || '').trim()}${tag ? ` [${tag}]` : ''}`;
    }

    function labelTexts(spec) {
        const out = [];
        if (spec.kind === 'stage' && oneLine(spec.completion)) out.push(`完成：${oneLine(spec.completion)}`);
        if (spec.kind === 'addon') {
            if (oneLine(spec.from)) out.push(`从：${oneLine(spec.from)}`);
            if (oneLine(spec.to)) out.push(`到：${oneLine(spec.to)}`);
        }
        if (spec.kind === 'merged' && oneLine(spec.merge)) out.push(`合并到：${oneLine(spec.merge)}`);
        return out;
    }

    function insertHeading(lines, atLine, spec, replaceLine) {
        const at = Math.max(0, Math.min(atLine, lines.length));
        const before = lines.slice(0, at);
        const after = lines.slice(replaceLine ? at + 1 : at);
        const inserted = [headingText(spec), ...labelTexts(spec)];
        if (before.length > 0 && before[before.length - 1].trim()) inserted.unshift('');
        return [...before, ...inserted, ...after];
    }

    function replaceHeading(lines, block, spec) {
        const remove = new Set([block.headingLine, ...block.labelLines]);
        const references = new Map();
        if (block.kind === 'stage' && spec.kind === 'stage' && spec.name !== block.name) {
            const parsed = parseOutline(lines.join('\n'));
            const target = parsed.stages.findIndex(stage => stage.headingLine === block.headingLine);
            // 旧模板允许《阶段名》、引号和换行标签；按解析后的端点更新。
            parsed.blocks.filter(item => item.kind === 'addon' || item.kind === 'merged').forEach(item => {
                const keys = item.kind === 'addon' ? ['from', 'to'] : ['merge'];
                keys.forEach(key => {
                    const value = item.labels[key];
                    if (target < 0 || resolveStageRef(value, parsed.stages) !== target) return;
                    if (/^第?\s*\d+\s*(?:段|章|节|阶段)?$/.test(String(value).trim())
                        && squash(value) !== squash(block.name)) return;
                    item.labelLines.forEach(at => {
                        const label = at < lines.length ? parseLabelLine(lines[at]) : null;
                        if (!label || label.key !== key) return;
                        references.set(at, `${LABEL_TEXT_BY_KEY[key]}：${spec.name}`);
                        if (!label.value) {
                            for (let next = at + 1; item.labelLines.includes(next) && !parseLabelLine(lines[next]); next += 1) {
                                remove.add(next);
                            }
                        }
                    });
                });
            });
        }
        const result = [];
        lines.forEach((line, index) => {
            if (index === block.headingLine) {
                result.push(headingText(spec), ...labelTexts(spec));
            } else if (!remove.has(index)) {
                result.push(references.has(index) ? references.get(index) : line);
            }
        });
        return result;
    }

    function collapseBlankRuns(lines) {
        const out = [];
        lines.forEach(line => {
            if (!line.trim() && out.length > 0 && !out[out.length - 1].trim()) return;
            out.push(line);
        });
        while (out.length > 0 && !out[0].trim()) out.shift();
        return out;
    }

    function deleteHeading(lines, block) {
        const remove = new Set([block.headingLine, ...block.labelLines]);
        return collapseBlankRuns(lines.filter((line, index) => !remove.has(index)));
    }

    // 整块搬移：标题 + 标签 + 正文一起上移/下移一个块，块内结构不动。
    // 第一个块不能再上移（前面是前言区），最后一个块不能再下移。
    function moveBlock(lines, block, delta) {
        const parsed = parseOutline(lines.join('\n'));
        const at = parsed.blocks.findIndex(item => item.headingLine === block.headingLine);
        const swap = at + delta;
        if (at < 0 || swap < 0 || swap >= parsed.blocks.length) return lines.slice();
        const fresh = parsed.blocks[at];
        const other = parsed.blocks[swap];
        const removed = fresh.end - fresh.headingLine;
        const chunk = lines.slice(fresh.headingLine, fresh.end);
        while (chunk.length > 1 && !chunk[chunk.length - 1].trim()) chunk.pop();
        const rest = lines.slice(0, fresh.headingLine).concat(lines.slice(fresh.end));
        // 下移时 other.end 是原坐标，要减去被抽走的行数
        const insertAt = delta > 0 ? other.end - removed : other.headingLine;
        const before = rest.slice(0, insertAt);
        const after = rest.slice(insertAt);
        if (before.length > 0 && before[before.length - 1].trim()) before.push('');
        if (after.length > 0 && after[0].trim()) chunk.push('');
        return collapseBlankRuns(before.concat(chunk, after));
    }

    // 还没有任何标题时的快捷方式：每个空行隔开的块算一段，短的第一行当标题。
    function autoSplitByBlankLines(lines) {
        const result = [];
        let index = 0;
        let count = 0;
        while (index < lines.length) {
            if (!lines[index].trim()) {
                result.push(lines[index]);
                index += 1;
                continue;
            }
            let end = index;
            while (end < lines.length && lines[end].trim()) end += 1;
            const chunk = lines.slice(index, end);
            count += 1;
            const first = chunk[0].trim();
            const looksLikeTitle = chunk.length > 1
                && first.length <= 24
                && !/[。！？!?，,；;…”"）)]$/.test(first)
                && !parseLabelLine(first);
            if (looksLikeTitle) {
                result.push(`## ${first}`, ...chunk.slice(1));
            } else {
                result.push(`## 第 ${count} 段`, ...chunk);
            }
            index = end;
        }
        return result;
    }

    // ---------------------------------------------------------------
    // 一、核心：识别并转换 1.x 的旧版划分
    //
    // 1.x 把阶段划分存在 entry.extra 和正文末尾的 Base64 标记里。
    // 2.0 只认正文里的标题行，所以旧条目要一次性转换成标题行写法。
    // ---------------------------------------------------------------

    const LEGACY_META_KEY = 'dynamicGuideAssistant';
    const LEGACY_MARKER_RE = /\n*<!--\s*DGA_LAYOUT_V1:BEGIN\s*-->[\s\S]*?<!--\s*DGA_LAYOUT_V1:END\s*-->\n*/gi;
    const LEGACY_MARKER_CAPTURE_RE = /<!--\s*DGA_LAYOUT_V1:BEGIN\s*-->([\s\S]*?)<!--\s*DGA_LAYOUT_V1:END\s*-->/i;

    function base64ToUtf8(value) {
        const source = String(value || '').replace(/\s+/g, '');
        if (!source) return '';
        if (typeof atob === 'function' && typeof TextDecoder === 'function') {
            const binary = atob(source);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return new TextDecoder('utf-8').decode(bytes);
        }
        if (typeof Buffer !== 'undefined') return Buffer.from(source, 'base64').toString('utf8');
        throw new Error('当前环境无法解码旧版划分');
    }

    function stripLegacyMarker(content) {
        return normalizeText(content).replace(LEGACY_MARKER_RE, '\n').replace(/\s+$/, '');
    }

    function readLegacyLayout(entry) {
        const usable = layout => Boolean(
            layout && typeof layout === 'object' && layout.mode === 'ranges'
            && Array.isArray(layout.stages) && layout.stages.length > 0,
        );
        const meta = entry && entry.extra && typeof entry.extra === 'object' ? entry.extra[LEGACY_META_KEY] : null;
        if (meta && usable(meta.layout)) return meta.layout;
        const match = normalizeText(entry && entry.content).match(LEGACY_MARKER_CAPTURE_RE);
        if (!match) return null;
        try {
            const parsed = JSON.parse(base64ToUtf8(match[1].replace(/<!--[\s\S]*?-->/g, '')));
            return usable(parsed) ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    function hasLegacyLayout(entry) {
        return Boolean(readLegacyLayout(entry));
    }

    function resolveLegacyRange(text, range) {
        if (!range || typeof range !== 'object') return null;
        const quote = String(range.quote || '');
        const start = Number(range.start);
        const end = Number(range.end);
        if (Number.isInteger(start) && Number.isInteger(end) && end > start && end <= text.length) {
            if (!quote || text.slice(start, end) === quote) return { start, end };
        }
        if (!quote) return null;
        let best = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let at = text.indexOf(quote);
        while (at >= 0) {
            let score = -Math.abs(at - (Number.isFinite(start) ? start : 0));
            const prefix = String(range.prefix || '');
            const suffix = String(range.suffix || '');
            if (prefix && text.slice(Math.max(0, at - prefix.length), at) === prefix) score += 100000;
            if (suffix && text.slice(at + quote.length, at + quote.length + suffix.length) === suffix) score += 100000;
            if (score > bestScore) {
                bestScore = score;
                best = at;
            }
            at = text.indexOf(quote, at + 1);
        }
        return best >= 0 ? { start: best, end: best + quote.length } : null;
    }

    function convertLegacyLayout(content, layout) {
        const text = stripLegacyMarker(content);
        const pieces = [];
        (layout.stages || []).forEach((stage, index) => {
            (Array.isArray(stage.ranges) ? stage.ranges : []).forEach(range => {
                const hit = resolveLegacyRange(text, range);
                if (hit) pieces.push({ ...hit, owner: index });
            });
        });
        const alwaysRanges = layout.always && Array.isArray(layout.always.ranges) ? layout.always.ranges : [];
        alwaysRanges.forEach(range => {
            const hit = resolveLegacyRange(text, range);
            if (hit) pieces.push({ ...hit, owner: 'always' });
        });
        pieces.sort((left, right) => left.start - right.start || left.end - right.end);

        const bodyOf = owner => pieces
            .filter(piece => piece.owner === owner)
            .map(piece => escapeBodyText(text.slice(piece.start, piece.end).trim()))
            .filter(Boolean)
            .join('\n\n');

        const sections = [];
        (layout.stages || []).forEach((stage, index) => {
            const head = [`## ${String(stage.name || `阶段 ${index + 1}`).trim()}`];
            if (oneLine(stage.completion)) head.push(`完成：${oneLine(stage.completion)}`);
            sections.push([...head, bodyOf(index)].filter(Boolean).join('\n'));
        });
        const alwaysBody = bodyOf('always');
        if (alwaysBody) sections.push(`## 常驻提示 [常驻]\n${alwaysBody}`);

        const gaps = [];
        let cursor = 0;
        pieces.forEach(piece => {
            if (piece.start > cursor) gaps.push(text.slice(cursor, piece.start));
            cursor = Math.max(cursor, piece.end);
        });
        if (cursor < text.length) gaps.push(text.slice(cursor));
        const leftover = gaps.map(gap => gap.trim()).filter(Boolean).join('\n\n');
        if (leftover) sections.push(`## 旧版没有分配的文字 [备注]\n${escapeBodyText(leftover)}`);

        return sections.join('\n\n');
    }

    // ---------------------------------------------------------------
    // 一、核心：选区划分模式的载入与重建
    //
    // 选区模式不另外存一份数据：载入时把每个标题块的正文按文档顺序铺成
    // 一段连续文本，记下每段文字属于谁（ranges）；重建时按文字位置把
    // 阶段排序、写回标题行。没有归属的空隙文字收在最前面——那是第一个
    // 标题之前的位置，本来就不会发给 AI，再打开选区还能继续分配。
    // ---------------------------------------------------------------

    function normalizeRanges(ranges) {
        const sorted = (ranges || [])
            .filter(range => range && range.end > range.start)
            .map(range => ({ start: range.start, end: range.end }))
            .sort((left, right) => left.start - right.start || left.end - right.end);
        const out = [];
        sorted.forEach(range => {
            const last = out[out.length - 1];
            if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
            else out.push({ start: range.start, end: range.end });
        });
        return out;
    }

    function subtractRanges(list, cuts) {
        const incoming = normalizeRanges(cuts);
        if (incoming.length === 0) return normalizeRanges(list);
        const out = [];
        normalizeRanges(list).forEach(range => {
            let fragments = [range];
            incoming.forEach(cut => {
                const next = [];
                fragments.forEach(piece => {
                    if (cut.end <= piece.start || cut.start >= piece.end) {
                        next.push(piece);
                        return;
                    }
                    if (piece.start < cut.start) next.push({ start: piece.start, end: cut.start });
                    if (piece.end > cut.end) next.push({ start: cut.end, end: piece.end });
                });
                fragments = next;
            });
            out.push(...fragments);
        });
        return out;
    }

    function pickLoad(parsed) {
        const stages = parsed.stages.map((block, index) => ({
            id: block.id,
            kind: 'stage',
            name: block.name,
            completion: block.completion || '',
            ranges: [],
            color: block.color || STAGE_COLORS[index % STAGE_COLORS.length],
        }));
        const stageByBlock = new Map(parsed.stages.map((block, index) => [block, stages[index]]));
        const addons = [];
        const always = { id: 'always', kind: 'always', name: '常驻提示', ranges: [], color: KIND_COLORS.always };
        const note = { id: 'note', kind: 'note', name: '备注', ranges: [], color: KIND_COLORS.note };

        const pieces = [];
        const preamble = parsed.items
            .filter(item => item.kind === 'paragraph' && !item.block)
            .map(item => item.lines.join('\n').trim())
            .filter(Boolean)
            .join('\n\n');
        if (preamble) pieces.push({ owner: null, text: preamble });
        parsed.blocks.forEach(block => {
            // 并入块的正文在解析时已经拼进目标阶段的 prompt，不再单独铺。
            if (block.kind === 'merged') return;
            const text = String(block.prompt || '').trim();
            let owner = null;
            if (block.kind === 'stage') owner = stageByBlock.get(block);
            else if (block.kind === 'addon') {
                owner = {
                    id: `addon-${addons.length + 1}-${hashText(block.name).slice(0, 6)}`,
                    kind: 'addon',
                    name: block.name,
                    from: parsed.stages[block.fromIndex] ? parsed.stages[block.fromIndex].name : '',
                    to: parsed.stages[block.toIndex] ? parsed.stages[block.toIndex].name : '',
                    ranges: [],
                    color: KIND_COLORS.addon,
                };
                addons.push(owner);
            } else if (block.kind === 'always') owner = always;
            else if (block.kind === 'note') owner = note;
            if (text) pieces.push({ owner, text });
        });

        let text = '';
        pieces.forEach(piece => {
            if (text) text += '\n\n';
            const start = text.length;
            text += piece.text;
            if (piece.owner) piece.owner.ranges.push({ start, end: text.length });
        });

        const firstAlways = parsed.blocks.find(block => block.kind === 'always');
        return {
            text,
            stages,
            addons,
            always,
            note,
            // 常驻写在所有阶段之前 = 注入时排在阶段内容之前；重建要保留这个位置
            alwaysTop: Boolean(firstAlways && firstAlways.aboveStages),
            activeOwnerId: stages.length > 0 ? stages[0].id : 'always',
            pendingRanges: [],
            selectedMark: null,
            tapMode: false,
            tapHead: null,
            stale: false,
        };
    }

    function pickOwners(pick) {
        return [...pick.stages, ...pick.addons, pick.always, pick.note];
    }

    function pickOwner(pick, ownerId) {
        return pickOwners(pick).find(owner => owner.id === ownerId) || null;
    }

    function firstRangeStart(entry) {
        if (!entry.ranges || entry.ranges.length === 0) return Number.POSITIVE_INFINITY;
        return Math.min(...entry.ranges.map(range => range.start));
    }

    // 阶段顺序跟着文字走：第一个文字块排在前面，阶段就排在前面；
    // 还没有文字的阶段保持相对顺序排在最后。
    function sortedStages(pick) {
        return pick.stages.slice().sort((left, right) => firstRangeStart(left) - firstRangeStart(right));
    }

    function pickSafeName(name, fallback) {
        const cleaned = oneLine(name).replace(/[#【】\[\]]/g, '').trim();
        return cleaned || fallback;
    }

    function pickBuild(pick) {
        const text = String(pick && pick.text || '');
        const clamp = range => ({
            start: Math.max(0, Math.min(text.length, Number(range.start) || 0)),
            end: Math.max(0, Math.min(text.length, Number(range.end) || 0)),
        });
        const bodyOf = ranges => normalizeRanges((ranges || []).map(clamp))
            .map(range => escapeBodyText(text.slice(range.start, range.end).trim()))
            .filter(Boolean)
            .join('\n\n');

        const owned = [];
        const collect = ranges => (ranges || []).forEach(range => owned.push(clamp(range)));
        (pick.stages || []).forEach(stage => collect(stage.ranges));
        (pick.addons || []).forEach(addon => collect(addon.ranges));
        collect(pick.always && pick.always.ranges);
        collect(pick.note && pick.note.ranges);
        const gaps = [];
        let cursor = 0;
        normalizeRanges(owned).forEach(range => {
            if (range.start > cursor) gaps.push(text.slice(cursor, range.start));
            cursor = Math.max(cursor, range.end);
        });
        if (cursor < text.length) gaps.push(text.slice(cursor));
        const prefix = gaps.map(gap => gap.trim()).filter(Boolean).join('\n\n');

        const alwaysBody = bodyOf(pick.always && pick.always.ranges);
        const alwaysSection = alwaysBody ? `## 常驻提示 [常驻]\n${alwaysBody}` : '';
        const noteBody = bodyOf(pick.note && pick.note.ranges);
        const noteSection = noteBody ? `## 备注 [备注]\n${noteBody}` : '';
        const sections = [];
        if (prefix) sections.push(escapeBodyText(prefix));
        // 常驻“在上面”时写在所有阶段之前，否则留在附加之后
        if (alwaysSection && pick.alwaysTop) sections.push(alwaysSection);
        sortedStages(pick).forEach((stage, index) => {
            const head = [`## ${pickSafeName(stage.name, `阶段 ${index + 1}`)}`];
            if (oneLine(stage.completion)) head.push(`完成：${oneLine(stage.completion)}`);
            sections.push([...head, bodyOf(stage.ranges)].filter(Boolean).join('\n'));
        });
        (pick.addons || []).forEach((addon, index) => {
            const head = [`## ${pickSafeName(addon.name, `附加 ${index + 1}`)} [附加]`];
            if (oneLine(addon.from)) head.push(`从：${oneLine(addon.from)}`);
            if (oneLine(addon.to)) head.push(`到：${oneLine(addon.to)}`);
            sections.push([...head, bodyOf(addon.ranges)].filter(Boolean).join('\n'));
        });
        if (alwaysSection && !pick.alwaysTop) sections.push(alwaysSection);
        if (noteSection) sections.push(noteSection);
        return sections.join('\n\n');
    }

    // 把几段文字分给一个属主：先从所有属主减去这些区间，再并入新属主。
    // 于是把已分配的文字重新选一遍就能改归别人，和 1.3 选区编辑器一致。
    function pickAssign(pick, ownerId, ranges) {
        const owner = pickOwner(pick, ownerId);
        if (!owner) return false;
        const incoming = normalizeRanges(ranges);
        if (incoming.length === 0) return false;
        pick.stages.forEach(stage => { stage.ranges = subtractRanges(stage.ranges, incoming); });
        pick.addons.forEach(addon => { addon.ranges = subtractRanges(addon.ranges, incoming); });
        pick.always.ranges = subtractRanges(pick.always.ranges, incoming);
        pick.note.ranges = subtractRanges(pick.note.ranges, incoming);
        owner.ranges = normalizeRanges([...owner.ranges, ...incoming]);
        return true;
    }

    // 把某一段从它的属主手里拿回来（回到未分配）。
    function pickRemove(pick, ownerId, range) {
        const owner = pickOwner(pick, ownerId);
        if (!owner || !range) return false;
        const before = JSON.stringify(normalizeRanges(owner.ranges));
        owner.ranges = subtractRanges(owner.ranges, [range]);
        return JSON.stringify(owner.ranges) !== before;
    }

    // ---------------------------------------------------------------
    // 二、适配层：找到酒馆助手接口
    // ---------------------------------------------------------------

    const currentWindow = typeof window !== 'undefined' ? window : globalThis;
    const windowCandidates = [];
    const addWindowCandidate = candidate => {
        if (candidate && !windowCandidates.includes(candidate)) windowCandidates.push(candidate);
    };
    try { addWindowCandidate(currentWindow.top); } catch (error) {}
    try { addWindowCandidate(currentWindow.parent); } catch (error) {}
    addWindowCandidate(currentWindow);

    function getWandMenu(doc) {
        if (!doc) return null;
        return doc.getElementById('extensionsMenu')
            || doc.getElementById('extensions_menu')
            || doc.querySelector('.extensions_block .list-group');
    }

    function windowWithWandMenu() {
        return windowCandidates.find(candidate => {
            try {
                return Boolean(candidate.document && getWandMenu(candidate.document));
            } catch (error) {
                return false;
            }
        }) || null;
    }

    let hostWindow = windowWithWandMenu() || currentWindow;
    const helper = windowCandidates
        .map(candidate => {
            try { return candidate.TavernHelper; } catch (error) { return null; }
        })
        .find(Boolean) || null;
    const instanceToken = `dga-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const instanceWindow = windowCandidates.find(candidate => {
        try {
            candidate[INSTANCE_KEY] = instanceToken;
            return candidate[INSTANCE_KEY] === instanceToken;
        } catch (error) {
            return false;
        }
    }) || currentWindow;
    try {
        instanceWindow[INSTANCE_KEY] = instanceToken;
    } catch (error) {
        console.warn(`[${SCRIPT_NAME}] 无法在共享窗口保存实例标记`, error);
    }

    function isCurrentInstance() {
        try {
            return instanceWindow[INSTANCE_KEY] === instanceToken;
        } catch (error) {
            return true;
        }
    }

    function api(name, required) {
        for (const source of [helper, ...windowCandidates]) {
            try {
                if (source && typeof source[name] === 'function') return source[name].bind(source);
            } catch (error) {
                // 跨域顶层 WindowProxy 不允许读取属性，继续尝试同源窗口。
            }
        }
        if (required) throw new Error(`当前酒馆助手缺少 ${name} 接口`);
        return null;
    }

    function apiValue(name) {
        for (const source of [helper, ...windowCandidates]) {
            try {
                if (source && source[name] !== undefined) return source[name];
            } catch (error) {
                // 同上：跨域候选不是运行接口来源。
            }
        }
        return undefined;
    }

    function hostDocument() {
        const menuWindow = windowWithWandMenu();
        if (menuWindow) hostWindow = menuWindow;
        try {
            return hostWindow.document || currentWindow.document || null;
        } catch (error) {
            return currentWindow.document || null;
        }
    }

    function notify(message, type) {
        const level = type || 'info';
        const toast = hostWindow.toastr || currentWindow.toastr;
        if (toast && typeof toast[level] === 'function') {
            toast[level](message, SCRIPT_NAME);
        } else {
            (level === 'error' ? console.error : console.log)(`[${SCRIPT_NAME}] ${message}`);
        }
    }

    const reported = new Set();
    function reportOnce(key, message) {
        if (reported.has(key)) return;
        reported.add(key);
        notify(message, 'warning');
    }

    // ---------------------------------------------------------------
    // 二、适配层：变量（角色变量存绑定列表，聊天变量按绑定分别存进度）
    //
    // 一条绑定 = 一个被关闭的大纲条目。可以同时有好几条绑定，
    // 每条绑定的注入和进度都靠 bindingKey 区分开。
    // ---------------------------------------------------------------

    async function readVariables(type) {
        const getVariables = api('getVariables', true);
        const variables = await Promise.resolve(getVariables({ type }));
        return variables && typeof variables === 'object' ? variables : {};
    }

    async function updateVariables(type, updater) {
        const updateVariablesWith = api('updateVariablesWith', true);
        return Promise.resolve(updateVariablesWith(variables => {
            const safe = variables && typeof variables === 'object' ? variables : {};
            return updater(safe) || safe;
        }, { type }));
    }

    async function readRootField(type, field) {
        const variables = await readVariables(type);
        const root = variables[VARIABLE_ROOT];
        const value = root && typeof root === 'object' ? root[field] : null;
        return value && typeof value === 'object' ? value : null;
    }

    async function writeRootField(type, field, value) {
        return updateVariables(type, variables => {
            const root = variables[VARIABLE_ROOT] && typeof variables[VARIABLE_ROOT] === 'object'
                ? variables[VARIABLE_ROOT]
                : {};
            variables[VARIABLE_ROOT] = { ...root, [field]: value };
            return variables;
        });
    }

    const readRawConfig = () => readRootField('character', 'config');
    const writeConfig = config => writeRootField('character', 'config', config);
    const readRawState = () => readRootField('chat', 'state');

    function bindingKey(binding) {
        const target = binding && binding.entryUid != null
            ? `uid:${String(binding.entryUid)}`
            : `name:${String((binding && binding.entryName) || '')}`;
        return `${String((binding && binding.worldbookName) || '')}#${target}`;
    }

    // 每个绑定一条注入，id 带绑定指纹后缀，互不覆盖；旧版无后缀的注入由清理逻辑兜底。
    function injectionIdFor(key) {
        return `${INJECTION_ID}-${hashText(key).slice(0, 6)}`;
    }

    // 2.0 的 config 是扁平的单个绑定；2.1 变成 { version: 2, bindings: […] }。
    function normalizeConfig(raw) {
        const empty = { version: 2, bindings: [] };
        if (!raw || typeof raw !== 'object') return empty;
        const list = Array.isArray(raw.bindings)
            ? raw.bindings
            : (raw.worldbookName ? [raw] : []);
        const seen = new Set();
        const bindings = [];
        list.forEach(item => {
            if (!item || typeof item !== 'object' || !item.worldbookName) return;
            const binding = {
                worldbookName: String(item.worldbookName),
                entryUid: item.entryUid == null ? null : item.entryUid,
                entryName: String(item.entryName || ''),
                boundAt: item.boundAt || null,
            };
            const key = bindingKey(binding);
            if (seen.has(key)) return;
            seen.add(key);
            bindings.push(binding);
        });
        return { version: 2, bindings };
    }

    async function readConfig() {
        return normalizeConfig(await readRawConfig());
    }

    // 2.0 的 state 是扁平的单个进度；2.1 变成 { version: 2, bindings: { key: 进度 } }。
    // 旧进度并入第一个绑定名下；读出来发现是旧结构就顺手写回新版。
    async function readState(config) {
        const raw = await readRawState();
        if (raw && typeof raw === 'object' && raw.version === 2 && raw.bindings && typeof raw.bindings === 'object') {
            return raw.bindings;
        }
        const map = {};
        if (raw && typeof raw === 'object'
            && (Number.isInteger(raw.stageIndex) || Number.isInteger(raw.mainIndex))
            && config.bindings.length > 0) {
            map[bindingKey(config.bindings[0])] = raw;
            await writeRootField('chat', 'state', { version: 2, bindings: map });
        } else if (raw != null) {
            await writeRootField('chat', 'state', { version: 2, bindings: {} });
        }
        return map;
    }

    // state 传 null 表示删掉这条绑定的进度（移出绑定时用）。
    async function writeStateFor(key, state) {
        await updateVariables('chat', variables => {
            const root = variables[VARIABLE_ROOT] && typeof variables[VARIABLE_ROOT] === 'object'
                ? variables[VARIABLE_ROOT]
                : {};
            const old = root.state && typeof root.state === 'object'
                && root.state.version === 2 && root.state.bindings && typeof root.state.bindings === 'object'
                ? root.state.bindings
                : {};
            const bindings = { ...old };
            if (state == null) delete bindings[key];
            else bindings[key] = state;
            variables[VARIABLE_ROOT] = { ...root, state: { version: 2, bindings } };
            return variables;
        });
    }

    // ---------------------------------------------------------------
    // 二、适配层：角色与世界书
    // ---------------------------------------------------------------

    function cleanName(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : '';
    }

    function namesFrom(value) {
        if (!value) return [];
        if (typeof value === 'string') return cleanName(value) ? [cleanName(value)] : [];
        if (Array.isArray(value)) return value.flatMap(namesFrom);
        if (typeof value === 'object') {
            return [
                value.primary, value.world, value.worldbook, value.worldbookName, value.name,
                value.additional, value.worldbooks, value.names, value.books,
            ].flatMap(namesFrom);
        }
        return [];
    }

    async function currentCharacter() {
        const getCharData = api('getCharData', false);
        if (getCharData) {
            try {
                const card = await Promise.resolve(getCharData('current'));
                if (card && typeof card === 'object') return card;
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] 读取角色卡失败`, error);
            }
        }
        try {
            const tavern = currentWindow.SillyTavern || hostWindow.SillyTavern;
            const context = tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
            if (context && Array.isArray(context.characters)) {
                const id = Number(context.characterId);
                if (Number.isInteger(id)) return context.characters[id] || null;
            }
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取 SillyTavern 上下文失败`, error);
        }
        return null;
    }

    function characterName(card) {
        return cleanName(card && (card.name || (card.data && card.data.name))) || '当前角色';
    }

    function characterWorldbooks(card) {
        if (!card || typeof card !== 'object') return [];
        const extensions = (card.data && card.data.extensions) || card.extensions || {};
        return [
            ...namesFrom(extensions.world),
            ...namesFrom(card.world),
            ...namesFrom(extensions.worlds),
            ...namesFrom(extensions.additionalWorldbooks),
        ];
    }

    async function boundWorldbookNames(card) {
        const names = [];
        const getCharWorldbookNames = api('getCharWorldbookNames', false);
        if (getCharWorldbookNames) {
            try {
                names.push(...namesFrom(await Promise.resolve(getCharWorldbookNames('current'))));
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] getCharWorldbookNames 失败`, error);
            }
        }
        names.push(...characterWorldbooks(card));
        return Array.from(new Set(names.filter(Boolean)));
    }

    async function allWorldbookNames() {
        const getter = api('getWorldbookNames', false) || api('getLorebooks', false);
        if (!getter) return [];
        try {
            return Array.from(new Set(namesFrom(await Promise.resolve(getter()))));
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取世界书列表失败`, error);
            return [];
        }
    }

    async function getWorldbook(name) {
        return Promise.resolve(api('getWorldbook', true)(name));
    }

    async function updateWorldbook(name, updater) {
        return Promise.resolve(api('updateWorldbookWith', true)(name, updater));
    }

    function worldbookEntries(worldbook) {
        if (Array.isArray(worldbook)) return worldbook;
        if (!worldbook || typeof worldbook !== 'object') return [];
        if (Array.isArray(worldbook.entries)) return worldbook.entries;
        if (worldbook.entries && typeof worldbook.entries === 'object') return Object.values(worldbook.entries);
        return [];
    }

    function entryName(entry) {
        return String(entry && (entry.comment || entry.name || entry.title || `条目 ${entry.uid}`) || '未命名条目');
    }

    function sameUid(left, right) {
        return left != null && right != null && String(left) === String(right);
    }

    function findEntry(worldbook, uid, name) {
        const entries = worldbookEntries(worldbook);
        return entries.find(entry => sameUid(entry.uid, uid))
            || entries.find(entry => entryName(entry) === name)
            || null;
    }

    function entryIsDisabled(entry) {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.enabled === 'boolean') return entry.enabled === false;
        if (typeof entry.disable === 'boolean') return entry.disable === true;
        return false;
    }

    function entryKey(entry, index) {
        return entry && entry.uid != null ? `uid:${String(entry.uid)}` : `index:${index}`;
    }

    async function disableEntry(worldbookName, uid, name) {
        let found = false;
        await updateWorldbook(worldbookName, worldbook => {
            const entry = findEntry(worldbook, uid, name);
            if (!entry) return worldbook;
            found = true;
            entry.enabled = false;
            if ('disable' in entry) entry.disable = true;
            return worldbook;
        });
        if (!found) throw new Error(`在世界书“${worldbookName}”里找不到要禁用的条目`);
        const verified = findEntry(await getWorldbook(worldbookName), uid, name);
        if (!verified || !entryIsDisabled(verified)) {
            throw new Error('来源条目没能禁用。为了防止整份大纲泄露，这次绑定已停止。');
        }
    }

    async function writeEntryContent(worldbookName, uid, name, content) {
        let found = false;
        await updateWorldbook(worldbookName, worldbook => {
            const entry = findEntry(worldbook, uid, name);
            if (!entry) return worldbook;
            found = true;
            entry.content = content;
            if (entry.extra && typeof entry.extra === 'object' && entry.extra[LEGACY_META_KEY]) {
                const extra = { ...entry.extra };
                delete extra[LEGACY_META_KEY];
                entry.extra = extra;
            }
            return worldbook;
        });
        if (!found) throw new Error(`在世界书“${worldbookName}”里找不到要保存的条目`);
        const saved = findEntry(await getWorldbook(worldbookName), uid, name);
        if (!saved || normalizeText(saved.content) !== normalizeText(content)) {
            throw new Error('保存后读回的正文和要保存的内容不一致，请稍后重试。');
        }
        return saved;
    }

    // ---------------------------------------------------------------
    // 二、适配层：读取当前状态、注入、推进、绑定
    // ---------------------------------------------------------------

    async function locateEntry(config) {
        const bound = await boundWorldbookNames(await currentCharacter());
        const candidates = Array.from(new Set([config.worldbookName, ...bound].filter(Boolean)));
        for (const worldbookName of candidates) {
            try {
                const entry = findEntry(await getWorldbook(worldbookName), config.entryUid, config.entryName);
                if (entry) return { worldbookName, entry };
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] 读取世界书“${worldbookName}”失败`, error);
            }
        }
        return null;
    }

    // 只读。添加、推进、保存这些会写数据的动作都在各自的函数里。
    // 每条绑定各读各的：单个条目出问题（broken）不影响其他绑定。
    async function loadContexts() {
        const config = await readConfig();
        if (config.bindings.length === 0) return rememberContexts({ configured: false, config, contexts: [] });
        const stateMap = await readState(config);
        const contexts = [];
        for (const binding of config.bindings) {
            const key = bindingKey(binding);
            try {
                const located = await locateEntry(binding);
                if (!located) {
                    throw new Error(`找不到绑定的条目“${binding.entryName || ''}”。请在下面把它移出后重新添加。`);
                }
                const parsed = parseOutline(located.entry.content);
                const rawState = stateMap[key] || null;
                const state = reconcileState(rawState, parsed);
                contexts.push({
                    key,
                    binding,
                    configured: true,
                    worldbookName: located.worldbookName,
                    entry: located.entry,
                    parsed,
                    rawState,
                    state,
                    stage: parsed.stages[state.stageIndex] || null,
                    addons: activeAddons(parsed, state.stageIndex),
                    entryEnabled: !entryIsDisabled(located.entry),
                    legacy: hasLegacyLayout(located.entry),
                });
            } catch (error) {
                contexts.push({ key, binding, configured: true, broken: true, error: error.message || String(error) });
            }
        }
        return rememberContexts({ configured: true, config, contexts });
    }

    // 快捷指令（next/previous/reset）只操作第一条能用的绑定。
    async function requireContext() {
        const all = await loadContexts();
        const context = all.contexts.find(item => !item.broken);
        if (!context) throw new Error('还没有添加指导条目。');
        return context;
    }

    function statesDiffer(left, right) {
        return !left
            || left.stageIndex !== right.stageIndex
            || left.stageName !== right.stageName
            || left.lastCompletionMessageId !== right.lastCompletionMessageId
            || left.lastCompletionFingerprint !== right.lastCompletionFingerprint;
    }

    // 注入内容必须始终等于“现在该发的那一段”。酒馆或酒馆助手是否等待事件监听器
    // 返回的 Promise 因版本而异，所以这里不依赖生成事件：状态一变就同步更新注入，
    // 生成事件里再用缓存同步兜底一次，然后异步读回权威内容纠正。
    // byKey 按绑定分开记：text 为 undefined 表示“还不知道有没有注入过”，null 表示已清干净。
    const injectionCache = { all: null, byKey: {} };
    let clearedBaseInjection = false;

    function cacheFor(key) {
        if (!injectionCache.byKey[key]) injectionCache.byKey[key] = { text: undefined, key: null, channel: null };
        return injectionCache.byKey[key];
    }

    async function clearAllInjections() {
        const uninjectPrompts = api('uninjectPrompts', false);
        const channel = extensionPromptChannel();
        const ids = [INJECTION_ID];
        Object.keys(injectionCache.byKey).forEach(key => {
            if (injectionCache.byKey[key].text != null) ids.push(injectionIdFor(key));
        });
        if (uninjectPrompts) await Promise.resolve(uninjectPrompts(ids));
        if (channel) ids.forEach(id => channel.set(id, '', channel.types.NONE, 0));
        injectionCache.byKey = {};
        clearedBaseInjection = true;
    }

    // 清掉已经不在绑定列表里的注入；旧版无后缀 id 每页只清一次。
    function clearStaleInjections(activeIds) {
        const uninjectPrompts = api('uninjectPrompts', false);
        Object.keys(injectionCache.byKey).forEach(key => {
            const cache = injectionCache.byKey[key];
            const id = injectionIdFor(key);
            if (activeIds.includes(id)) return;
            if (cache.text != null) {
                if (uninjectPrompts) uninjectPrompts([id]);
                clearAnchorInjection(id);
            }
            delete injectionCache.byKey[key];
        });
        if (!clearedBaseInjection) {
            clearedBaseInjection = true;
            if (uninjectPrompts) uninjectPrompts([INJECTION_ID]);
            clearAnchorInjection(INJECTION_ID);
        }
    }

    // 把指导放回来源条目原来在提示词里的位置：条目是“按深度插入”时跟随它的深度和角色；
    // “角色定义前/后”改用酒馆原生扩展提示锚点（酒馆助手的注入只能插在聊天里，做不到这两个位置）；
    // 示例消息、作者注释等其余位置没有可复制的注入通道，仍然放在聊天末尾。
    function injectionPlacement(entry) {
        const position = (entry && entry.position) || {};
        if (position.type === 'at_depth') {
            const depth = Math.max(0, Number(position.depth) || 0);
            const role = position.role === 'user' || position.role === 'assistant' ? position.role : 'system';
            return { channel: 'in_chat', depth, role, followed: true };
        }
        if (position.type === 'before_character_definition') return { channel: 'anchor', slot: 'before', followed: true };
        if (position.type === 'after_character_definition') return { channel: 'anchor', slot: 'after', followed: true };
        return { channel: 'in_chat', depth: 0, role: 'system', followed: false };
    }

    function injectionPlacementText(placement) {
        if (!placement || !placement.followed) return '聊天末尾（深度 0）';
        if (placement.channel === 'anchor') {
            return placement.slot === 'before' ? '跟随大纲条目：角色定义前' : '跟随大纲条目：角色定义后';
        }
        return `跟随大纲条目：深度 ${placement.depth} · ${placement.role}`;
    }

    // 酒馆原生扩展提示接口：角色定义前/后锚点只能靠它。
    // 数值常量与酒馆源码 script.js 里的 extension_prompt_types 一致：
    // NONE=-1, IN_PROMPT=0（角色定义后）, IN_CHAT=1, BEFORE_PROMPT=2（角色定义前）。
    function extensionPromptChannel() {
        for (const candidate of windowCandidates) {
            try {
                const tavern = candidate && candidate.SillyTavern;
                const context = tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
                if (context && typeof context.setExtensionPrompt === 'function') {
                    const types = context.extension_prompt_types
                        || { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
                    return { set: context.setExtensionPrompt.bind(context), types };
                }
            } catch (error) {
                // 跨域候选 WindowProxy 读属性会抛错，继续找同源窗口
            }
        }
        return null;
    }

    function clearAnchorInjection(id) {
        const channel = extensionPromptChannel();
        if (channel) channel.set(id || INJECTION_ID, '', channel.types.NONE, 0);
    }

    function currentMessageId() {
        const getLastMessageId = api('getLastMessageId', false);
        if (!getLastMessageId) return null;
        try {
            const value = getLastMessageId();
            return value == null ? null : value;
        } catch (error) {
            return null;
        }
    }

    function injectionTextFor(context, generationType) {
        if (!context || !context.configured) return null;
        if (context.legacy || context.parsed.stages.length === 0) return null;
        let index = context.state.stageIndex;
        // 刚靠完成标记推进过的那条消息如果被重新生成（swipe），仍按推进前的阶段注入
        if ((generationType === 'swipe' || generationType === 'regenerate')
            && index > 0
            && context.state.lastCompletionMessageId != null) {
            const lastId = currentMessageId();
            if (lastId != null && String(lastId) === String(context.state.lastCompletionMessageId)) index -= 1;
        }
        const stage = context.parsed.stages[index];
        if (!stage) return null;
        return formatInjection(stage, activeAddons(context.parsed, index));
    }

    function applyInjection(text, placement, key) {
        const id = injectionIdFor(key);
        const cache = cacheFor(key);
        const spot = placement || { channel: 'in_chat', depth: 0, role: 'system', followed: false };
        const where = spot.channel === 'anchor' ? spot.slot : `${spot.depth}|${spot.role}`;
        const cacheKey = text == null ? null : `${spot.channel}|${where}|${text}`;
        if (text != null && cache.key === cacheKey) return;
        const uninjectPrompts = api('uninjectPrompts', false);
        if (text == null) {
            if (cache.text !== null) {
                if (uninjectPrompts) uninjectPrompts([id]);
                clearAnchorInjection(id);
            }
            cache.text = null;
            cache.key = null;
            cache.channel = null;
            return;
        }
        if (spot.channel === 'anchor') {
            const channel = extensionPromptChannel();
            if (channel) {
                // 通道切换时清掉另一边的旧注入，避免同一段指导出现两次
                if (uninjectPrompts && cache.channel === 'in_chat') uninjectPrompts([id]);
                channel.set(id, text,
                    spot.slot === 'before' ? channel.types.BEFORE_PROMPT : channel.types.IN_PROMPT, 0, false, 0);
            } else {
                // 拿不到原生扩展提示接口时退化为聊天末尾，并说明原因
                reportOnce(`anchor-unavailable-${key}`, '当前环境没有酒馆原生扩展提示接口，指导改放在聊天末尾（深度 0）。');
                api('injectPrompts', true)([{
                    id,
                    position: 'in_chat',
                    depth: 0,
                    role: 'system',
                    content: text,
                    should_scan: false,
                }]);
            }
        } else {
            if (cache.channel === 'anchor') clearAnchorInjection(id);
            api('injectPrompts', true)([{
                id,
                position: 'in_chat',
                depth: spot.depth,
                role: spot.role,
                content: text,
                should_scan: false,
            }]);
        }
        cache.text = text;
        cache.key = cacheKey;
        cache.channel = spot.channel;
    }

    function rememberContexts(all) {
        injectionCache.all = all;
        return all;
    }

    // 用缓存里的上下文同步对齐注入内容：不读世界书，也不等任何 Promise。
    function syncInjection(generationType) {
        const all = injectionCache.all;
        if (!all) return;
        all.contexts.forEach(context => {
            if (context.broken) return;
            applyInjection(injectionTextFor(context, generationType), injectionPlacement(context.entry), context.key);
        });
    }

    async function injectCurrentGuide(generationType) {
        // 先按缓存同步注入：即使酒馆没有等待这个事件，这次请求也已经带上当前阶段。
        syncInjection(generationType);
        const all = await loadContexts();
        const activeIds = [];
        for (const context of all.contexts) {
            if (context.broken) {
                reportOnce(`broken-${context.key}`, context.error);
                continue;
            }
            activeIds.push(injectionIdFor(context.key));
            if (context.entryEnabled) {
                // 来源条目又被打开了：为了不让整份大纲直接发给 AI，生成前重新关闭它。
                // 旧格式尚未转换或正文暂时没有阶段时，也必须保持来源关闭。
                await disableEntry(context.worldbookName, context.entry.uid, entryName(context.entry));
                reportOnce(`re-disabled-${context.key}`, `“${entryName(context.entry)}”被重新打开过，已再次关闭，避免整份大纲直接发给 AI。`);
            }
            if (context.legacy) {
                reportOnce(`legacy-layout-${context.key}`, `“${entryName(context.entry)}”仍使用旧版划分。请先打开动态指导助手，点“转换成新版格式”；转换前不会注入指导。`);
                applyInjection(null, null, context.key);
                continue;
            }
            if (context.parsed.stages.length === 0) {
                reportOnce(`no-stages-${context.key}`, `“${entryName(context.entry)}”还没有分阶段，这次不会注入指导。`);
                applyInjection(null, null, context.key);
                continue;
            }
            if (statesDiffer(context.rawState, context.state)) {
                await writeStateFor(context.key, { ...context.state, updatedAt: new Date().toISOString() });
            }
            applyInjection(injectionTextFor(context, generationType), injectionPlacement(context.entry), context.key);
        }
        clearStaleInjections(activeIds);
    }

    async function moveToIndex(context, target, options) {
        const settings = options || {};
        const total = context.parsed.stages.length;
        const index = Math.max(0, Math.min(target, total));
        const next = {
            stageIndex: index,
            stageName: context.parsed.stages[index] ? context.parsed.stages[index].name : '',
            lastCompletionMessageId: settings.messageId == null
                ? context.state.lastCompletionMessageId
                : settings.messageId,
            lastCompletionFingerprint: settings.fingerprint || context.state.lastCompletionFingerprint,
            updatedAt: new Date().toISOString(),
        };
        await writeStateFor(context.key, next);
        // 进度一变就把注入内容换成新阶段，下一次生成不需要等任何异步读取。
        if (injectionCache.all) {
            const at = injectionCache.all.contexts.findIndex(item => item.key === context.key);
            if (at >= 0) {
                injectionCache.all.contexts[at] = {
                    ...injectionCache.all.contexts[at],
                    state: next,
                    stage: context.parsed.stages[index] || null,
                    addons: activeAddons(context.parsed, index),
                };
            }
        }
        syncInjection('normal');
        if (settings.notify !== false) {
            const label = entryName(context.entry);
            notify(next.stageName
                ? `「${label}」当前阶段：${next.stageName}`
                : `「${label}」全部阶段已完成，之后不再注入指导。`, 'success');
        }
        return next;
    }

    async function addBinding(worldbookName, entry, options) {
        const settings = options || {};
        if (!worldbookName || !entry) throw new Error('请先选择世界书和大纲条目。');
        const fresh = findEntry(await getWorldbook(worldbookName), entry.uid, entryName(entry));
        if (!fresh) throw new Error('这个条目已经不存在了，请刷新后重试。');
        if (hasLegacyLayout(fresh)) throw new Error('这个条目还是旧版划分，请先点“转换成新版格式”。');
        const parsed = parseOutline(fresh.content);
        if (parsed.stages.length === 0) {
            throw new Error('这个条目还没有剧情阶段。先点“划分阶段”，把某个段落设为第一阶段的开头。');
        }
        const config = await readConfig();
        const candidate = {
            worldbookName,
            entryUid: fresh.uid,
            entryName: entryName(fresh),
            boundAt: new Date().toISOString(),
        };
        const key = bindingKey(candidate);
        const existing = config.bindings.some(item => bindingKey(item) === key);
        if (settings.confirm !== false) {
            const accepted = hostWindow.confirm(
                `${existing ? '重新添加' : '添加'}“${entryName(fresh)}”为指导条目？\n\n`
                + `共 ${parsed.stages.length} 个阶段${parsed.addons.length ? `、${parsed.addons.length} 个附加内容` : ''}。\n`
                + '添加后会关闭这个条目，避免整份大纲直接发给 AI；当前聊天从第一段开始。',
            );
            if (!accepted) return false;
        }
        await disableEntry(worldbookName, fresh.uid, entryName(fresh));
        const bindings = existing
            ? config.bindings.map(item => (bindingKey(item) === key ? { ...item, ...candidate } : item))
            : [...config.bindings, candidate];
        await writeConfig({ version: 2, bindings });
        await writeStateFor(key, {
            stageIndex: 0,
            stageName: parsed.stages[0].name,
            lastCompletionMessageId: null,
            lastCompletionFingerprint: '',
            updatedAt: new Date().toISOString(),
        });
        // 立刻按最新绑定列表重新注入，不用等下一次事件。
        await injectCurrentGuide('normal');
        notify(`已添加“${entryName(fresh)}”，当前阶段：${parsed.stages[0].name}`, 'success');
        return true;
    }

    async function unbindEntry(key, options) {
        const settings = options || {};
        const config = await readConfig();
        const binding = config.bindings.find(item => bindingKey(item) === key);
        if (!binding) throw new Error('没有找到这条绑定。');
        const located = await locateEntry(binding);
        if (settings.confirm !== false) {
            const accepted = hostWindow.confirm(
                `移出“${binding.entryName || '这个条目'}”？\n\n`
                + '移出后会重新打开这个条目（恢复成普通的世界书条目），并删掉它在当前聊天的进度。',
            );
            if (!accepted) return false;
        }
        // 先恢复条目，再删绑定；即使中途失败也不会留下“条目关着却没人管”的状态。
        if (located) {
            await updateWorldbook(located.worldbookName, worldbook => {
                const target = findEntry(worldbook, binding.entryUid, binding.entryName);
                if (!target) return worldbook;
                target.enabled = true;
                if ('disable' in target) target.disable = false;
                return worldbook;
            });
        }
        await writeConfig({ version: 2, bindings: config.bindings.filter(item => bindingKey(item) !== key) });
        await writeStateFor(key, null);
        // 直接清掉这条注入，并把它从缓存里摘掉。
        applyInjection(null, null, key);
        delete injectionCache.byKey[key];
        if (injectionCache.all) {
            const contexts = injectionCache.all.contexts.filter(item => item.key !== key);
            injectionCache.all = { ...injectionCache.all, contexts, configured: contexts.length > 0 };
        }
        notify(`已移出“${binding.entryName || '条目'}”，条目已重新打开。`, 'success');
        return true;
    }

    async function disableEntryNow(key) {
        const all = await loadContexts();
        const context = all.contexts.find(item => item.key === key && !item.broken);
        if (!context) throw new Error('这条绑定现在不可用。');
        await disableEntry(context.worldbookName, context.entry.uid, entryName(context.entry));
        context.entryEnabled = false;
        notify(`已关闭“${entryName(context.entry)}”。`, 'success');
        return true;
    }

    function messageIdFromArgs(args) {
        for (const value of args) {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (value && typeof value === 'object' && Number.isFinite(value.message_id)) return value.message_id;
        }
        return null;
    }

    async function handleMessageReceived() {
        if (!isCurrentInstance()) return;
        const args = Array.from(arguments);
        const getLastMessageId = api('getLastMessageId', true);
        const getChatMessages = api('getChatMessages', true);
        const requested = messageIdFromArgs(args);
        const messageId = requested == null ? await Promise.resolve(getLastMessageId()) : requested;
        const messages = await Promise.resolve(getChatMessages(messageId, { include_swipes: false }));
        const message = Array.isArray(messages) ? messages[0] : null;
        if (!message || message.role !== 'assistant' || typeof message.message !== 'string') return;

        const markers = Array.from(message.message.matchAll(COMPLETE_MARKER_RE));
        if (markers.length === 0) return;
        const all = await loadContexts();
        if (!all.configured) return;

        const cleaned = message.message.replace(COMPLETE_MARKER_RE, '').trimEnd();
        const setChatMessages = api('setChatMessages', false);
        if (setChatMessages && cleaned !== message.message) {
            await Promise.resolve(setChatMessages([{ message_id: messageId, message: cleaned }], { refresh: 'affected' }));
        }
        // 一条消息可能同时完成好几条绑定的阶段：按各自的阶段 id 指纹分别推进。
        for (const context of all.contexts) {
            if (context.broken || !context.stage) continue;
            const fingerprint = `${messageId}:${context.stage.id}:${hashText(cleaned)}`;
            if (context.state.lastCompletionFingerprint === fingerprint) continue;
            if (!markers.some(match => match[1] === context.stage.id)) continue;
            await moveToIndex(context, context.state.stageIndex + 1, { messageId, fingerprint });
        }
    }

    // ---------------------------------------------------------------
    // 三、界面：状态与小工具
    // ---------------------------------------------------------------

    const ui = {
        view: 'manager',
        renderedView: '',
        busy: false,
        message: null,
        openPreviews: {},
        characterName: '当前角色',
        boundNames: [],
        worldbookNames: [],
        selectedWorldbook: '',
        entries: [],
        entryError: '',
        selectedEntryKey: '',
        snapshot: null,
        contextError: '',
        editor: null,
    };

    function el(tag, attrs, ...children) {
        const doc = hostDocument();
        const node = doc.createElement(tag);
        Object.entries(attrs || {}).forEach(([key, value]) => {
            if (value == null || value === false) return;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'style' && typeof value === 'object') {
                Object.entries(value).forEach(([name, item]) => node.style.setProperty(name, item));
            } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
            else if (value === true) node.setAttribute(key, '');
            else node.setAttribute(key, String(value));
        });
        children.flat(Infinity).forEach(child => {
            if (child == null || child === false) return;
            node.append(typeof child === 'object' && child.nodeType ? child : doc.createTextNode(String(child)));
        });
        return node;
    }

    function btn(text, onclick, options) {
        const settings = options || {};
        const classes = ['dga-btn'];
        if (settings.primary) classes.push('dga-primary');
        if (settings.danger) classes.push('dga-danger');
        if (settings.ghost) classes.push('dga-ghost');
        return el('button', {
            type: 'button',
            class: classes.join(' '),
            disabled: Boolean(ui.busy || settings.disabled),
            onclick,
        }, text);
    }

    function card(title, ...children) {
        return el('section', { class: 'dga-card' }, title ? el('h3', { text: title }) : null, ...children);
    }

    function muted(text) {
        return el('p', { class: 'dga-muted', text });
    }

    function row(...children) {
        return el('div', { class: 'dga-row' }, ...children);
    }

    function field(label, control) {
        return el('label', { class: 'dga-field' }, el('span', { text: label }), control);
    }

    function selectControl(options, value, onchange) {
        const select = el('select', { onchange: event => onchange(event.target.value) });
        options.forEach(option => select.append(el('option', { value: option.value, text: option.label })));
        select.value = value;
        if (select.value !== value && options.length > 0) select.value = options[0].value;
        select.disabled = ui.busy || options.length === 0;
        return select;
    }

    function messageBar(message) {
        const item = message || ui.message;
        return item ? el('div', { class: 'dga-msg', 'data-type': item.type || 'info', text: item.text }) : null;
    }

    function setMessage(text, type) {
        ui.message = text ? { text, type: type || 'info' } : null;
    }

    function header(title, subtitle, onclose, closeLabel) {
        return el('header', { class: 'dga-head' },
            el('div', { class: 'dga-head-text' },
                el('h2', { text: title }),
                subtitle ? el('small', { text: subtitle }) : null),
            el('button', {
                type: 'button',
                class: 'dga-btn dga-ghost dga-close',
                'aria-label': closeLabel || '关闭',
                onclick: onclose,
            }, closeLabel || '×'),
        );
    }

    function ensureStyle(doc) {
        const target = doc || hostDocument();
        if (!target || !(target.head || target.documentElement)) return;
        if (target.getElementById(STYLE_ID)) return;
        const style = target.createElement('style');
        style.id = STYLE_ID;
        style.textContent = styles();
        (target.head || target.documentElement).appendChild(style);
    }

    function ensurePanel() {
        const doc = hostDocument();
        if (!doc || !doc.body) return null;
        ensureStyle(doc);
        let panel = doc.getElementById(PANEL_ID);
        if (panel) return panel;
        panel = el('div', {
            id: PANEL_ID,
            hidden: true,
            role: 'dialog',
            'aria-modal': 'true',
            onclick: event => {
                if (event.target === panel) closePanel();
            },
            onkeydown: event => {
                if (event.key !== 'Escape') return;
                if (ui.view === 'editor' && ui.editor && ui.editor.sheet) closeSheet();
                else closePanel();
            },
        });
        panel.append(el('div', { class: 'dga-shell', tabindex: -1 }));
        doc.body.appendChild(panel);
        return panel;
    }

    function render() {
        const panel = ensurePanel();
        if (!panel) return;
        const shell = panel.querySelector('.dga-shell');
        const oldBody = shell.querySelector('.dga-body');
        const scrollTop = oldBody && ui.renderedView === ui.view ? oldBody.scrollTop : 0;
        shell.replaceChildren(...(ui.view === 'editor' ? renderEditor() : renderManager()));
        shell.classList.toggle('dga-busy', ui.busy);
        const body = shell.querySelector('.dga-body');
        if (body) body.scrollTop = scrollTop;
        ui.renderedView = ui.view;
    }

    function closePanel() {
        if (ui.view === 'editor' && editorUnsaved(ui.editor)
            && !hostWindow.confirm('还有没保存的修改，确定关闭？')) return;
        const panel = ensurePanel();
        if (panel) panel.hidden = true;
        discardEditor();
        ui.view = 'manager';
    }

    // 所有按钮动作都从这里走：置忙、执行、失败时把原因显示在页面上。
    async function runAction(label, action, options) {
        const settings = options || {};
        if (ui.busy) return;
        ui.busy = true;
        ui.message = null;
        render();
        try {
            const result = await action();
            if (result !== false && settings.refresh !== false) await refresh();
            if (result !== false && settings.success) setMessage(settings.success, 'success');
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] ${label}失败`, error);
            setMessage(error.message || String(error), 'error');
        } finally {
            ui.busy = false;
            render();
        }
    }

    async function refresh(options) {
        const settings = options || {};
        const card = await currentCharacter();
        const [bound, all] = await Promise.all([boundWorldbookNames(card), allWorldbookNames()]);
        ui.characterName = characterName(card);
        ui.boundNames = bound;
        ui.worldbookNames = bound.length > 0 ? bound : all;
        try {
            ui.snapshot = await loadContexts();
            ui.contextError = '';
        } catch (error) {
            ui.snapshot = null;
            ui.contextError = error.message || String(error);
        }
        const firstBinding = ui.snapshot && ui.snapshot.config.bindings[0];
        const wanted = settings.worldbookName || ui.selectedWorldbook || (firstBinding && firstBinding.worldbookName) || '';
        ui.selectedWorldbook = ui.worldbookNames.includes(wanted) ? wanted : (ui.worldbookNames[0] || '');
        ui.entries = [];
        ui.entryError = '';
        if (ui.selectedWorldbook) {
            try {
                ui.entries = worldbookEntries(await getWorldbook(ui.selectedWorldbook));
            } catch (error) {
                ui.entryError = `读取世界书失败：${error.message || String(error)}`;
            }
        }
        ui.selectedEntryKey = pickEntryKey(settings.entryKey || ui.selectedEntryKey);
    }

    function pickEntryKey(requested) {
        const keys = ui.entries.map((entry, index) => entryKey(entry, index));
        if (requested && keys.includes(requested)) return requested;
        const ready = ui.entries.findIndex(entry => hasLegacyLayout(entry) || parseOutline(entry.content).stages.length > 0);
        if (ready >= 0) return keys[ready];
        return keys[0] || '';
    }

    function selectedEntry() {
        const index = ui.entries.findIndex((entry, position) => entryKey(entry, position) === ui.selectedEntryKey);
        return index >= 0 ? ui.entries[index] : null;
    }

    function bindingForEntry(worldbookName, entry) {
        const bindings = ui.snapshot ? ui.snapshot.config.bindings : [];
        const name = entryName(entry);
        return bindings.find(item => item.worldbookName === worldbookName
            && (sameUid(item.entryUid, entry.uid) || item.entryName === name)) || null;
    }

    function entryLabel(entry) {
        const name = entryName(entry);
        if (hasLegacyLayout(entry)) return `${name}（旧版划分，需转换）`;
        const parsed = parseOutline(entry.content);
        const marks = [];
        marks.push(parsed.stages.length > 0
            ? `${parsed.stages.length} 段${parsed.addons.length ? `、${parsed.addons.length} 附加` : ''}`
            : '未分阶段');
        if (bindingForEntry(ui.selectedWorldbook, entry)) marks.push('已添加');
        else if (entryIsDisabled(entry)) marks.push('已关闭');
        return `${name}（${marks.join(' · ')}）`;
    }

    // ---------------------------------------------------------------
    // 三、界面：管理页
    // ---------------------------------------------------------------

    function renderManager() {
        const snapshot = ui.snapshot;
        const contexts = snapshot ? snapshot.contexts : [];
        const body = el('div', { class: 'dga-body' },
            messageBar(),
            ui.contextError ? messageBar({ type: 'error', text: ui.contextError }) : null,
            ...contexts.map(boundCard),
            contexts.length === 0 ? guideCard() : null,
            addCard(),
        );
        return [header(SCRIPT_NAME, `v${VERSION} · ${ui.characterName}`, closePanel), body];
    }

    // 一条绑定一张卡：条目名、走到哪一段、上一段/下一段，外加一排不常用的操作。
    function boundCard(context) {
        if (context.broken) {
            return card(null,
                el('div', { class: 'dga-bound-head' },
                    el('div', { class: 'dga-heading-text' },
                        el('b', { text: (context.binding && context.binding.entryName) || '未知条目' }),
                        el('small', { text: (context.binding && context.binding.worldbookName) || '' }))),
                messageBar({ type: 'error', text: context.error }),
                btn('移出这条绑定', () => runAction('移出绑定', () => unbindEntry(context.key)), { danger: true }),
            );
        }
        const total = context.parsed.stages.length;
        const index = context.state.stageIndex;
        const finished = total > 0 && index >= total;
        const usable = !context.legacy && total > 0;
        const move = (label, target, confirmText) => runAction(label, async () => {
            if (confirmText && !hostWindow.confirm(confirmText)) return false;
            const fresh = (await loadContexts()).contexts.find(item => item.key === context.key);
            if (!fresh || fresh.broken) throw new Error('这条绑定现在不可用。');
            return moveToIndex(fresh, target);
        });

        const details = el('details', {
            class: 'dga-fold',
            open: Boolean(ui.openPreviews[context.key]),
            ontoggle: event => { ui.openPreviews[context.key] = event.target.open; },
        }, el('summary', { text: '现在发给 AI 的内容' }));
        const parts = [];
        if (context.stage && usable) {
            parts.push(`【${context.stage.name}】\n${context.stage.prompt}`);
            context.addons.forEach(item => parts.push(`【附加：${item.name}】\n${item.prompt}`));
            parts.push(context.stage.completion
                ? `【进入下一段的条件（由 AI 判断）】\n${context.stage.completion}`
                : '【进入下一段】\n没有写完成条件，只能手动点“下一段”。');
        } else {
            parts.push('现在不发送任何指导。');
        }
        details.append(el('pre', { class: 'dga-pre', text: parts.join('\n\n') }));
        details.append(muted(`注入位置：${injectionPlacementText(injectionPlacement(context.entry))}`));
        if (context.parsed.warnings.length > 0) {
            details.append(messageBar({ type: 'warning', text: context.parsed.warnings.join('\n') }));
        }

        const tag = context.legacy ? '旧版'
            : (total === 0 ? '未分段' : (finished ? '已完成' : `第 ${index + 1} 段`));
        return card(null,
            el('div', { class: 'dga-bound-head' },
                el('div', { class: 'dga-heading-text' },
                    el('b', { text: entryName(context.entry) }),
                    el('small', { text: context.worldbookName })),
                el('span', {
                    class: 'dga-tag',
                    style: { '--dga-c': context.stage && usable ? context.stage.color : '#6b7280' },
                    text: tag,
                })),
            context.legacy
                ? messageBar({ type: 'warning', text: '这个条目还是旧版（1.x）的划分，转换前不会注入。在下面选中它，点“转换成新版格式”。' })
                : null,
            !context.legacy && total === 0
                ? messageBar({ type: 'warning', text: '这个条目还没有分阶段，暂时不会注入。在下面选中它，点“划分阶段”。' })
                : null,
            usable ? el('div', {
                class: 'dga-stage-name',
                text: finished ? `全部 ${total} 段已完成，之后不再发送指导` : `第 ${index + 1} 段 · 共 ${total} 段 — ${context.stage.name}`,
            }) : null,
            context.entryEnabled ? messageBar({
                type: 'warning',
                text: '这个条目现在是打开状态，整份大纲可能会直接发给 AI。下次生成前会自动关闭它，也可以现在手动关。',
            }) : null,
            context.entryEnabled
                ? btn('立即关闭条目', () => runAction('关闭条目', () => disableEntryNow(context.key)), { danger: true })
                : null,
            row(
                btn('上一段', () => move('切换到上一段', index - 1), { disabled: !usable || index <= 0 }),
                btn('下一段', () => move('切换到下一段', index + 1), { primary: true, disabled: !usable || index >= total }),
            ),
            details,
            row(
                btn('重新划分', () => runAction('打开编辑器', () => openEditorAt(context.worldbookName, context.entry), { refresh: false }), { ghost: true }),
                btn('回到第一段', () => move('重置进度', 0, '把这个聊天的进度重置到第一段？'), { ghost: true, disabled: !usable || index === 0 }),
                btn('移出', () => runAction('移出绑定', () => unbindEntry(context.key)), { ghost: true }),
            ),
        );
    }

    // 添加区：两个下拉选条目，然后“划分阶段”或“添加为指导条目”。
    function addCard() {
        const selected = selectedEntry();
        const legacy = Boolean(selected && hasLegacyLayout(selected));
        const parsed = selected && !legacy ? parseOutline(selected.content) : null;
        const selectedBinding = selected ? bindingForEntry(ui.selectedWorldbook, selected) : null;
        const children = [];

        if (ui.worldbookNames.length === 0) {
            children.push(messageBar({ type: 'warning', text: '没有找到任何世界书。请先给角色绑定一个世界书，并把大纲写进一个条目里。' }));
        } else {
            if (ui.boundNames.length === 0) children.push(muted('没检测到这个角色绑定的世界书，下面列出的是全部世界书。'));
            children.push(field('世界书', selectControl(
                ui.worldbookNames.map(name => ({ value: name, label: name })),
                ui.selectedWorldbook,
                value => runAction('切换世界书', async () => {
                    ui.selectedWorldbook = value;
                    ui.selectedEntryKey = '';
                }),
            )));
            const entryOptions = ui.entries.length > 0
                ? ui.entries.map((entry, index) => ({ value: entryKey(entry, index), label: entryLabel(entry) }))
                : [{ value: '', label: ui.entryError || '这个世界书里没有条目' }];
            children.push(field('条目', selectControl(entryOptions, ui.selectedEntryKey, value => {
                ui.selectedEntryKey = value;
                render();
            })));
        }

        if (selected && legacy) {
            children.push(
                messageBar({ type: 'warning', text: '这个条目带有旧版（1.x）的阶段划分。新版直接把阶段写在正文里，需要先转换一次。' }),
                btn('转换成新版格式', () => runAction('转换旧版划分', convertSelectedLegacy), { primary: true }),
            );
        } else if (selected && parsed) {
            children.push(muted(parsed.stages.length > 0
                ? `这个条目有 ${parsed.stages.length} 个阶段${parsed.addons.length ? `、${parsed.addons.length} 个附加内容` : ''}。`
                : '这个条目还没有分阶段。'));
        }

        children.push(row(
            btn('划分阶段', () => runAction('打开编辑器', () => openEditorAt(ui.selectedWorldbook, selected), { refresh: false }), {
                primary: !selectedBinding && Boolean(parsed) && parsed.stages.length === 0,
                disabled: !selected || legacy,
            }),
            btn(selectedBinding ? '重新添加（进度归零）' : '添加为指导条目',
                () => runAction('添加指导条目', () => addBinding(ui.selectedWorldbook, selected)), {
                primary: Boolean(parsed) && parsed.stages.length > 0 && !selectedBinding,
                disabled: !selected || legacy || !parsed || parsed.stages.length === 0,
            }),
        ));
        children.push(muted('添加后会关闭这个条目，AI 只能看到当前阶段的切片；想看回全文时点卡片上的“移出”就会重新打开。'));
        children.push(btn('刷新', () => runAction('刷新', async () => {}), { ghost: true }));
        return card('添加指导条目', ...children);
    }

    function guideCard() {
        return card('三步上手',
            el('ol', { class: 'dga-steps' },
                el('li', {}, '在角色绑定的世界书里新建一个条目，把完整大纲写进去，用空行分开各段。'),
                el('li', {}, '在下面选中这个条目，点“划分阶段”：点一个段落把它设成某一阶段的开头，也可以切到“编辑原文”直接改正文。'),
                el('li', {}, '点“保存并添加”。之后每次聊天，AI 只会收到当前这一段的内容。'),
            ),
            muted('可以同时添加好几个条目，各自独立推进、各自注入回原来的位置。也可以直接在正文里写“## 阶段名”分段；写“合并到：阶段名”可以把这段并进已有阶段。'),
        );
    }

    async function convertSelectedLegacy() {
        const entry = selectedEntry();
        const layout = entry ? readLegacyLayout(entry) : null;
        if (!layout) throw new Error('这个条目没有旧版划分。');
        const content = convertLegacyLayout(entry.content, layout);
        await writeEntryContent(ui.selectedWorldbook, entry.uid, entryName(entry), content);
        setMessage('已转换成新版格式。建议点“划分阶段”检查一遍，再重新绑定。', 'success');
    }

    // ---------------------------------------------------------------
    // 三、界面：划分阶段编辑器
    //
    // 正文按段落一块块列出来。点一个段落 → 把它设成某个标题的开头；
    // 点一个标题 → 改名、改类型、改条件或删掉。正文文字本身不会被改。
    // ---------------------------------------------------------------

    async function openEditorAt(worldbookName, entry) {
        if (!worldbookName || !entry) throw new Error('请先选择一个条目。');
        const fresh = findEntry(await getWorldbook(worldbookName), entry.uid, entryName(entry));
        if (!fresh) throw new Error('这个条目已经不存在了，请刷新后重试。');
        const lines = normalizeText(fresh.content).split('\n');
        const config = ui.snapshot && ui.snapshot.config ? ui.snapshot.config : await readConfig();
        const candidate = { worldbookName, entryUid: fresh.uid, entryName: entryName(fresh) };
        const bound = config.bindings.some(item => bindingKey(item) === bindingKey(candidate));
        ui.editor = {
            worldbookName,
            entry: fresh,
            lines,
            parsed: parseOutline(lines.join('\n')),
            dirty: false,
            sheet: null,
            mode: 'doc',
            bound,
            pick: null,
            pickListeners: null,
        };
        ui.view = 'editor';
    }

    // 选区模式里改过名字、条件但还没重建正文，也算有未保存的修改。
    function editorUnsaved(editor) {
        return Boolean(editor && (editor.dirty || (editor.pick && editor.pick.stale)));
    }

    function discardEditor() {
        if (ui.editor) pickDetach(ui.editor);
        ui.editor = null;
    }

    function closeEditor(force) {
        if (!force && editorUnsaved(ui.editor) && !hostWindow.confirm('还有没保存的修改，确定放弃？')) return;
        discardEditor();
        ui.view = 'manager';
        render();
    }

    function renderEditor() {
        const editor = ui.editor;
        const parsed = editor.parsed;
        const mode = editor.mode;
        const hasHeadings = parsed.blocks.length > 0;
        const docChildren = [];
        if (parsed.items.length === 0) {
            docChildren.push(muted('这个条目是空的。先在世界书里把大纲写好，再来分段。'));
        }
        let hintShown = false;
        parsed.items.forEach(item => {
            if (item.kind === 'heading') {
                docChildren.push(headingCard(item.block));
                return;
            }
            if (!item.block && hasHeadings && !hintShown) {
                docChildren.push(el('p', { class: 'dga-hint', text: '↓ 第一个标题之前的文字不会发给 AI' }));
                hintShown = true;
            }
            docChildren.push(paragraphCard(item));
        });

        const rawArea = el('textarea', { class: 'dga-raw', rows: 14, spellcheck: 'false' });
        rawArea.value = editor.lines.join('\n');
        // 原文编辑时不要整页重绘，否则每敲一个字就会丢焦点。
        rawArea.addEventListener('input', event => {
            editor.lines = normalizeText(event.target.value).split('\n');
            editor.dirty = true;
        });
        const modeButton = (label, target) => el('button', {
            type: 'button',
            class: `dga-seg-btn dga-mode-${target}${mode === target ? ' is-on' : ''}`,
            onclick: () => setEditorMode(target, rawArea),
        }, label);
        const toolbar = el('div', { class: 'dga-toolbar' },
            el('div', { class: 'dga-seg dga-mode-seg' },
                modeButton('看分段', 'doc'),
                modeButton('选区划分', 'pick'),
                modeButton('编辑原文', 'raw')),
            mode === 'doc' && hasHeadings ? muted('点段落设开头 · 点标题改名或改条件') : null,
        );
        const helpText = mode === 'raw'
            ? '这里是世界书条目的原文，可以直接改：增删文字、调整顺序、自己写“## 阶段名”都行。回到“看分段”会重新按标题分段。'
            : mode === 'pick'
                ? '先点下面的一个分段，再在正文上拖选一段文字，点“分配给”它。触屏不好拖选时，用“点选头尾”点两下也行。没分配的文字留在最前面，不会发给 AI。'
                : '想怎么分就怎么分：点一个段落设成某一阶段的开头，点标题改名、改条件、并入别的阶段或删掉。也可以切到“编辑原文”直接改正文。';
        const pickStages = mode === 'pick' && editor.pick ? editor.pick.stages.length : 0;
        const body = el('div', { class: 'dga-body' },
            messageBar(),
            el('p', { class: 'dga-help', text: helpText }),
            toolbar,
            mode === 'doc' && !hasHeadings && parsed.items.length > 0
                ? btn('按空行自动分段（每块的第一行当标题）', () => {
                    editor.lines = autoSplitByBlankLines(editor.lines);
                    editor.mode = 'doc';
                    afterEdit();
                }, { primary: true })
                : null,
            mode === 'raw' ? rawArea
                : mode === 'pick' ? renderPick(editor)
                    : el('div', { class: 'dga-doc' }, ...docChildren),
            mode === 'doc' && hasHeadings ? messageBar({ type: 'info', text: `现在有 ${parsed.stages.length} 个剧情阶段${parsed.addons.length ? `、${parsed.addons.length} 个附加内容` : ''}。${parsed.warnings.length ? `\n${parsed.warnings.join('\n')}` : ''}` }) : null,
        );
        const foot = el('footer', { class: 'dga-foot' },
            btn('保存', () => runAction('保存', () => saveEditor(false), { refresh: false }), { primary: editor.bound }),
            editor.bound ? null : btn('保存并添加', () => runAction('保存并添加', () => saveEditor(true), { refresh: false }), {
                primary: true,
                disabled: mode !== 'raw' && parsed.stages.length === 0 && pickStages === 0,
            }),
        );
        const parts = [
            header('划分阶段', `${entryName(editor.entry)}${editorUnsaved(editor) ? ' · 未保存' : ''}`, () => closeEditor(false), '返回'),
            body,
            foot,
        ];
        if (editor.sheet) parts.push(renderSheet(editor.sheet));
        return parts;
    }

    function setEditorMode(mode, rawArea) {
        const editor = ui.editor;
        if (!editor || editor.mode === mode) return;
        if (editor.mode === 'raw' && rawArea) {
            editor.lines = normalizeText(rawArea.value).split('\n');
            editor.parsed = parseOutline(editor.lines.join('\n'));
        }
        if (editor.mode === 'pick') {
            pickDetach(editor);
            if (editor.pick && editor.pick.stale) {
                editor.lines = normalizeText(pickBuild(editor.pick)).split('\n');
                editor.parsed = parseOutline(editor.lines.join('\n'));
                editor.dirty = true;
            }
            editor.pick = null;
        }
        editor.mode = mode;
        if (mode === 'pick') {
            editor.pick = pickLoad(editor.parsed);
            pickAttach(editor);
        }
        render();
    }

    function headingSubtitle(block) {
        if (block.kind === 'stage') return block.completion ? `进入下一段：${block.completion}` : '手动点“下一段”推进';
        if (block.kind === 'addon') {
            const stages = ui.editor.parsed.stages;
            if (stages.length === 0) return '还没有剧情阶段';
            return block.fromIndex === block.toIndex
                ? `只在第 ${block.fromIndex + 1} 段有效`
                : `第 ${block.fromIndex + 1} 段到第 ${block.toIndex + 1} 段有效`;
        }
        if (block.kind === 'merged') {
            const stage = ui.editor.parsed.stages[block.mergeInto];
            return stage ? `并入「${stage.name}」，和它一起发送` : '找不到要并入的阶段，已按独立阶段处理';
        }
        if (block.kind === 'always') return block.aboveStages ? '每一段都发送 · 排在阶段内容之前' : '每一段都发送 · 排在阶段内容之后';
        return '只给自己看，不发送';
    }

    function pressable(attrs, handler) {
        return {
            ...attrs,
            role: 'button',
            tabindex: 0,
            onclick: handler,
            onkeydown: event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handler();
                }
            },
        };
    }

    function headingCard(block) {
        const editor = ui.editor;
        const blocks = editor.parsed.blocks;
        const at = blocks.findIndex(item => item.headingLine === block.headingLine);
        const tag = block.kind === 'stage' ? `第 ${block.stageIndex + 1} 段` : KIND_LABELS[block.kind];
        // 整块上移/下移：标题、标签、正文一起动；常驻挪到所有阶段之前 = 注入时排在阶段内容之前
        const moveBtn = (label, delta, disabled, title) => el('button', {
            type: 'button',
            class: 'dga-move',
            title,
            disabled: Boolean(disabled),
            onclick: event => {
                event.stopPropagation();
                editor.lines = moveBlock(editor.lines, block, delta);
                afterEdit();
            },
        }, label);
        return el('div', pressable({ class: 'dga-heading', style: { '--dga-c': block.color } }, () => openSheet({ mode: 'edit', block })),
            el('span', { class: 'dga-tag', text: tag }),
            el('div', { class: 'dga-heading-text' },
                el('b', { text: block.name }),
                el('small', { text: headingSubtitle(block) })),
            el('span', { class: 'dga-move-wrap' },
                moveBtn('↑', -1, at <= 0, '上移一块'),
                moveBtn('↓', 1, at < 0 || at >= blocks.length - 1, '下移一块')),
            el('span', { class: 'dga-chev', text: '›' }),
        );
    }

    function paragraphCard(item) {
        return el('div', pressable({ class: `dga-para${item.block ? '' : ' dga-dim'}` }, () => openSheet({ mode: 'new', item })),
            item.lines.join('\n'));
    }

    function openSheet(spec) {
        if (ui.busy) return;
        const editor = ui.editor;
        const stages = editor.parsed.stages;
        const nameAt = index => (stages[index] ? stages[index].name : '');
        if (spec.mode === 'new') {
            const item = spec.item;
            const first = item.lines[0].trim();
            const titleLike = item.lines.length > 1 && first.length <= 24 && !/[。！？!?，,；;…”"）)]$/.test(first);
            const anchor = item.block
                ? (item.block.kind === 'stage' ? item.block.stageIndex : item.block.anchorStage)
                : 0;
            editor.sheet = {
                mode: 'new',
                atLine: item.start,
                name: titleLike ? first : '',
                kind: 'stage',
                completion: '',
                from: nameAt(anchor),
                to: nameAt(anchor),
                merge: nameAt(anchor),
                lineOptions: item.lines.map((text, offset) => ({
                    value: String(item.start + offset),
                    label: `${item.start + offset + 1}. ${oneLine(text).slice(0, 20) || '（空行）'}`,
                })),
                canConsumeFirstLine: titleLike,
                consumeFirstLine: titleLike,
                error: '',
            };
        } else {
            const block = spec.block;
            const isAddon = block.kind === 'addon';
            const isMerged = block.kind === 'merged';
            editor.sheet = {
                mode: 'edit',
                block,
                name: block.name,
                kind: block.kind,
                completion: block.completion || '',
                from: nameAt(isAddon ? block.fromIndex : block.anchorStage),
                to: nameAt(isAddon ? block.toIndex : block.anchorStage),
                merge: nameAt(isMerged ? block.mergeInto : block.anchorStage),
                canConsumeFirstLine: false,
                consumeFirstLine: false,
                error: '',
            };
        }
        render();
    }

    function closeSheet() {
        if (ui.editor) ui.editor.sheet = null;
        render();
    }

    function afterEdit() {
        const editor = ui.editor;
        editor.parsed = parseOutline(editor.lines.join('\n'));
        editor.dirty = true;
        editor.sheet = null;
        render();
    }

    function renderSheet(sheet) {
        const editor = ui.editor;
        const stages = editor.parsed.stages.filter(stage => !(sheet.mode === 'edit' && stage === sheet.block));
        const backdrop = el('div', {
            class: 'dga-sheet-bg',
            onclick: event => {
                if (event.target === backdrop) closeSheet();
            },
        });
        const box = el('div', { class: 'dga-sheet', role: 'dialog' });
        box.append(el('h3', { text: sheet.mode === 'new' ? '从这一段开始一个新标题' : '修改这个标题' }));
        if (sheet.error) box.append(messageBar({ type: 'error', text: sheet.error }));

        const nameInput = el('input', {
            type: 'text',
            maxlength: 60,
            placeholder: '例如：雨夜初遇',
            oninput: event => { sheet.name = event.target.value; },
        });
        nameInput.value = sheet.name;
        box.append(field('名称', nameInput));

        if (sheet.mode === 'new' && sheet.lineOptions && sheet.lineOptions.length > 1) {
            box.append(field('从这一段的哪一行开始', selectControl(sheet.lineOptions, String(sheet.atLine), value => {
                sheet.atLine = Number(value);
                render();
            })));
        }

        if (sheet.canConsumeFirstLine) {
            const checkbox = el('input', { type: 'checkbox', onchange: event => { sheet.consumeFirstLine = event.target.checked; } });
            checkbox.checked = sheet.consumeFirstLine;
            box.append(el('label', { class: 'dga-check' }, checkbox, el('span', { text: '选中的那一行就是标题，把它变成标题行' })));
        }

        box.append(field('这是什么', el('div', { class: 'dga-seg' },
            ...['stage', 'merged', 'addon', 'always', 'note'].map(kind => el('button', {
                type: 'button',
                class: `dga-seg-btn${sheet.kind === kind ? ' is-on' : ''}`,
                onclick: () => {
                    sheet.kind = kind;
                    render();
                },
            }, KIND_LABELS[kind])),
        )));

        if (sheet.kind === 'stage') {
            const completion = el('textarea', {
                rows: 2,
                placeholder: '例如：两人完成第一次正式交谈。留空就只能手动点“下一段”。',
                oninput: event => { sheet.completion = event.target.value; },
            });
            completion.value = sheet.completion;
            box.append(field('什么时候进入下一段（AI 自己判断）', completion));
        }
        if (sheet.kind === 'addon') {
            if (stages.length === 0) {
                box.append(muted('还没有剧情阶段。先把上面的段落设成阶段，再来设置附加内容的有效范围。'));
            } else {
                const options = stages.map(stage => ({ value: stage.name, label: `第 ${stage.stageIndex + 1} 段 · ${stage.name}` }));
                if (!options.some(option => option.value === sheet.from)) sheet.from = options[0].value;
                if (!options.some(option => option.value === sheet.to)) sheet.to = sheet.from;
                box.append(field('从哪一段开始有效', selectControl(options, sheet.from, value => {
                    sheet.from = value;
                    render();
                })));
                box.append(field('到哪一段为止（含这一段）', selectControl(options, sheet.to, value => {
                    sheet.to = value;
                    render();
                })));
            }
            box.append(muted('附加内容不占进度，只在指定的几段里一起发给 AI，适合物品、地点规则、秘密。'));
        }
        if (sheet.kind === 'merged') {
            if (stages.length === 0) {
                box.append(muted('还没有剧情阶段。先把某个段落设成阶段，再让这段文字并进去。'));
            } else {
                const options = stages.map(stage => ({ value: stage.name, label: `第 ${stage.stageIndex + 1} 段 · ${stage.name}` }));
                if (!options.some(option => option.value === sheet.merge)) sheet.merge = options[0].value;
                box.append(field('并进哪一个阶段', selectControl(options, sheet.merge, value => {
                    sheet.merge = value;
                    render();
                })));
            }
            box.append(muted('这段文字会和那个阶段一起发给 AI，但它自己不占进度：一个阶段就能吃掉几段不连续的内容。'));
        }
        if (sheet.kind === 'always') box.append(muted('这部分会在每一段都发给 AI。'));
        if (sheet.kind === 'note') box.append(muted('这部分只给作者自己看，不会发给 AI。'));

        const actions = [
            btn(sheet.mode === 'new' ? '添加标题' : '保存修改', applySheet, { primary: true }),
            btn('取消', closeSheet),
        ];
        if (sheet.mode === 'edit') actions.push(btn('删除这个标题', deleteSheetHeading, { danger: true }));
        box.append(el('div', { class: 'dga-sheet-actions' }, ...actions));
        backdrop.append(box);
        return backdrop;
    }

    function applySheet() {
        const editor = ui.editor;
        const sheet = editor && editor.sheet;
        if (!sheet) return;
        const name = String(sheet.name || '').trim();
        if (!name) {
            sheet.error = '请先填写名称。';
            render();
            return;
        }
        if (/[#【】\[\]]/.test(name)) {
            sheet.error = '名称里不要用 #、【】、[] 这些符号。';
            render();
            return;
        }
        if (sheet.kind === 'merged' && !String(sheet.merge || '').trim()) {
            sheet.error = '请选择要并进的阶段。';
            render();
            return;
        }
        const spec = {
            name,
            kind: sheet.kind,
            completion: sheet.completion,
            from: sheet.kind === 'addon' ? sheet.from : '',
            to: sheet.kind === 'addon' ? sheet.to : '',
            merge: sheet.kind === 'merged' ? sheet.merge : '',
        };
        if (sheet.mode === 'new') {
            editor.lines = insertHeading(editor.lines, sheet.atLine, spec, sheet.canConsumeFirstLine && sheet.consumeFirstLine);
        } else {
            editor.lines = replaceHeading(editor.lines, sheet.block, spec);
        }
        afterEdit();
    }

    function deleteSheetHeading() {
        const editor = ui.editor;
        const sheet = editor && editor.sheet;
        if (!sheet || sheet.mode !== 'edit') return;
        if (!hostWindow.confirm(`删除标题“${sheet.block.name}”？下面的文字会并入上一段。`)) return;
        editor.lines = deleteHeading(editor.lines, sheet.block);
        afterEdit();
    }

    // ---------------------------------------------------------------
    // 三、界面：选区划分
    //
    // 正文铺成一段可以拖选的连续文字，每个分段一种颜色：
    //   - 拖选（鼠标或触屏系统选区）→ 进入“待分配”，再点“分配给”当前分段；
    //   - 触屏不好拖选时开“点选头尾”：点一下设开头，再点一下设结尾；
    //   - 点已上色的文字 = 把它所在的分段设为当前分段，可以再“移除选中段”。
    // 分配和移除会立刻按归属重建正文（pickCommit），名字和条件的修改
    // 则在离开选区或保存时一次性重建，打字时不会丢焦点。
    // ---------------------------------------------------------------

    function pickSurfaceNode() {
        const doc = hostDocument();
        const panel = doc && doc.getElementById(PANEL_ID);
        return panel ? panel.querySelector('.dga-pick-surface') : null;
    }

    function nodeContains(root, node) {
        let current = node;
        while (current) {
            if (current === root) return true;
            current = current.parentNode;
        }
        return false;
    }

    function clearNativeSelection() {
        const doc = hostDocument();
        const view = (doc && doc.defaultView) || hostWindow;
        try {
            const selection = view && typeof view.getSelection === 'function' ? view.getSelection() : null;
            if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
        } catch (error) {
            // 没有选区接口的环境直接忽略
        }
    }

    // 用 Range 量出“从正文开头到某个节点位置”的字数，也就是选区偏移。
    function textOffsetTo(surface, node, offset) {
        const doc = hostDocument();
        if (!doc || typeof doc.createRange !== 'function') return null;
        try {
            const range = doc.createRange();
            range.selectNodeContents(surface);
            range.setEnd(node, offset);
            return range.toString().length;
        } catch (error) {
            return null;
        }
    }

    function selectionOffsets() {
        const surface = pickSurfaceNode();
        const doc = hostDocument();
        if (!surface || !doc) return null;
        const view = doc.defaultView || hostWindow;
        let selection = null;
        try {
            selection = view && typeof view.getSelection === 'function' ? view.getSelection() : null;
        } catch (error) {
            return null;
        }
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
        let native = null;
        try { native = selection.getRangeAt(0); } catch (error) { return null; }
        if (!native || !nodeContains(surface, native.startContainer) || !nodeContains(surface, native.endContainer)) return null;
        const start = textOffsetTo(surface, native.startContainer, native.startOffset);
        const end = textOffsetTo(surface, native.endContainer, native.endOffset);
        if (start == null || end == null) return null;
        return { start: Math.min(start, end), end: Math.max(start, end) };
    }

    function offsetAtPoint(x, y) {
        const surface = pickSurfaceNode();
        const doc = hostDocument();
        if (!surface || !doc) return null;
        let node = null;
        let offset = 0;
        try {
            if (typeof doc.caretRangeFromPoint === 'function') {
                const caret = doc.caretRangeFromPoint(x, y);
                if (caret) { node = caret.startContainer; offset = caret.startOffset; }
            } else if (typeof doc.caretPositionFromPoint === 'function') {
                const caret = doc.caretPositionFromPoint(x, y);
                if (caret) { node = caret.offsetNode; offset = caret.offset; }
            }
        } catch (error) {
            return null;
        }
        if (!node || !nodeContains(surface, node)) return null;
        return textOffsetTo(surface, node, offset);
    }

    // 把当前系统选区收进“待分配”。选完立刻清掉系统高亮，改由我们的底色显示。
    function captureSelection(editor) {
        const pick = editor && editor.pick;
        if (!pick || editor.mode !== 'pick') return;
        const range = selectionOffsets();
        if (!range || range.end - range.start < 1) return;
        pick.pendingRanges = normalizeRanges([...pick.pendingRanges, range]);
        pick.selectedMark = null;
        clearNativeSelection();
        if (editor.pickListeners) editor.pickListeners.ignoreClickUntil = Date.now() + 300;
        render();
    }

    // 点选头尾：第一下记开头，第二下把两点之间收进“待分配”。
    function placeTapMarker(editor, offset) {
        const pick = editor && editor.pick;
        if (!pick || offset == null) return;
        if (pick.tapHead == null) {
            pick.tapHead = offset;
        } else {
            const start = Math.min(pick.tapHead, offset);
            const end = Math.max(pick.tapHead, offset);
            pick.tapHead = null;
            if (end > start) {
                pick.pendingRanges = normalizeRanges([...pick.pendingRanges, { start, end }]);
                pick.selectedMark = null;
            }
        }
        render();
    }

    // 结构性修改（分配、移除、删除分段）后：按归属重建正文并重新载入选区。
    function pickCommit(editor, removedId) {
        const pick = editor && editor.pick;
        if (!pick) return;
        const active = pickOwner(pick, pick.activeOwnerId);
        const activeKey = active && active.id !== removedId ? `${active.kind}：${active.name}` : '';
        const tapMode = pick.tapMode;
        editor.lines = normalizeText(pickBuild(pick)).split('\n');
        editor.parsed = parseOutline(editor.lines.join('\n'));
        editor.dirty = true;
        editor.pick = pickLoad(editor.parsed);
        editor.pick.tapMode = tapMode;
        if (activeKey) {
            const found = pickOwners(editor.pick).find(owner => `${owner.kind}：${owner.name}` === activeKey);
            if (found) editor.pick.activeOwnerId = found.id;
        }
        render();
    }

    function pickAssignPending(editor) {
        const pick = editor && editor.pick;
        if (!pick || pick.pendingRanges.length === 0) return;
        if (pickAssign(pick, pick.activeOwnerId, pick.pendingRanges)) pickCommit(editor);
    }

    function pickRemoveSelected(editor) {
        const pick = editor && editor.pick;
        if (!pick || !pick.selectedMark) return;
        if (pickRemove(pick, pick.selectedMark.ownerId, pick.selectedMark)) pickCommit(editor);
    }

    function pickNewOwner(editor, kind) {
        const pick = editor && editor.pick;
        if (!pick) return;
        const serial = `${Date.now().toString(36)}-${pick.stages.length + pick.addons.length}`;
        if (kind === 'stage') {
            const stage = {
                id: `pick-stage-${serial}`,
                kind: 'stage',
                name: `第 ${pick.stages.length + 1} 段`,
                completion: '',
                ranges: [],
                color: STAGE_COLORS[pick.stages.length % STAGE_COLORS.length],
            };
            pick.stages.push(stage);
            pick.activeOwnerId = stage.id;
        } else {
            const first = sortedStages(pick)[0];
            const addon = {
                id: `pick-addon-${serial}`,
                kind: 'addon',
                name: `附加 ${pick.addons.length + 1}`,
                from: first ? first.name : '',
                to: first ? first.name : '',
                ranges: [],
                color: KIND_COLORS.addon,
            };
            pick.addons.push(addon);
            pick.activeOwnerId = addon.id;
        }
        pick.stale = true;
        render();
    }

    function pickDeleteOwner(editor, owner) {
        const pick = editor && editor.pick;
        if (!pick || !owner) return;
        if (!hostWindow.confirm(`删除「${owner.name}」？它的文字会回到未分配。`)) return;
        if (owner.kind === 'stage') {
            const sorted = sortedStages(pick);
            const fallback = sorted[sorted.indexOf(owner) + 1] || sorted[sorted.indexOf(owner) - 1] || null;
            pick.stages = pick.stages.filter(item => item !== owner);
            pick.addons.forEach(addon => {
                if (addon.from === owner.name) addon.from = fallback ? fallback.name : '';
                if (addon.to === owner.name) addon.to = fallback ? fallback.name : '';
            });
        } else if (owner.kind === 'addon') {
            pick.addons = pick.addons.filter(item => item !== owner);
        }
        pickCommit(editor, owner.id);
    }

    // 选区模式的文档级监听：拖选手势期间不碰选区；手指滑动当成滚页面，
    // 停掉这次选区；手机上拖系统手柄只触发 selectionchange，防抖后读取。
    function pickAttach(editor) {
        const listeners = {
            gestureOpen: false,
            touchActive: false,
            touchMoved: false,
            touchX: 0,
            touchY: 0,
            ignoreSelectionUntil: 0,
            ignoreClickUntil: 0,
            timer: 0,
            onSelectionChange: null,
            onScroll: null,
            onMouseUp: null,
        };
        editor.pickListeners = listeners;
        const doc = hostDocument();
        if (!doc || typeof doc.addEventListener !== 'function') return;
        listeners.onSelectionChange = () => {
            if (!ui.editor || ui.editor !== editor || editor.mode !== 'pick') return;
            if (listeners.gestureOpen || listeners.touchActive) return;
            if (Date.now() < listeners.ignoreSelectionUntil) return;
            if (listeners.timer && typeof hostWindow.clearTimeout === 'function') hostWindow.clearTimeout(listeners.timer);
            listeners.timer = hostWindow.setTimeout(() => {
                listeners.timer = 0;
                captureSelection(editor);
            }, 140);
        };
        listeners.onScroll = () => {
            if (!listeners.touchActive) return;
            listeners.touchMoved = true;
            clearNativeSelection();
            listeners.ignoreSelectionUntil = Date.now() + 600;
        };
        listeners.onMouseUp = () => {
            if (!listeners.gestureOpen) return;
            listeners.gestureOpen = false;
            captureSelection(editor);
        };
        doc.addEventListener('selectionchange', listeners.onSelectionChange);
        doc.addEventListener('scroll', listeners.onScroll, true);
        doc.addEventListener('mouseup', listeners.onMouseUp);
    }

    function pickDetach(editor) {
        const listeners = editor && editor.pickListeners;
        const doc = hostDocument();
        if (doc && listeners && typeof doc.removeEventListener === 'function') {
            if (listeners.onSelectionChange) doc.removeEventListener('selectionchange', listeners.onSelectionChange);
            if (listeners.onScroll) doc.removeEventListener('scroll', listeners.onScroll, true);
            if (listeners.onMouseUp) doc.removeEventListener('mouseup', listeners.onMouseUp);
        }
        if (listeners && listeners.timer && typeof hostWindow.clearTimeout === 'function') hostWindow.clearTimeout(listeners.timer);
        if (editor) editor.pickListeners = null;
    }

    function renderPick(editor) {
        const pick = editor.pick;
        if (!pick.text) {
            return el('div', { class: 'dga-pick' },
                renderPickSide(editor),
                muted('这个条目还没有正文。切到“编辑原文”先写内容，再回来拖选划分。'));
        }
        return el('div', { class: 'dga-pick' },
            renderPickSide(editor),
            renderPickBar(editor),
            renderPickSurface(editor));
    }

    function renderPickBar(editor) {
        const pick = editor.pick;
        const owner = pickOwner(pick, pick.activeOwnerId);
        const chars = pick.pendingRanges.reduce((sum, range) => sum + (range.end - range.start), 0);
        const bar = el('div', { class: 'dga-pick-bar' });
        if (pick.tapMode) {
            bar.append(
                el('span', {
                    class: 'dga-pick-bar-text',
                    text: pick.tapHead == null ? '点选：点一下正文，设开头' : '再点一下，设结尾',
                }),
                btn('退出点选', () => {
                    pick.tapMode = false;
                    pick.tapHead = null;
                    render();
                }, { ghost: true }));
            return bar;
        }
        bar.append(el('span', {
            class: 'dga-pick-bar-text',
            text: chars > 0 ? `已准备 ${pick.pendingRanges.length} 段 · ${chars} 字` : '在下面的正文上拖选文字',
        }));
        if (pick.selectedMark) bar.append(btn('移除选中段', () => pickRemoveSelected(editor), { danger: true }));
        bar.append(
            btn(owner ? `分配给「${oneLine(owner.name).slice(0, 12)}」` : '先选一个分段', () => pickAssignPending(editor), {
                primary: true,
                disabled: chars === 0 || !owner,
            }),
            btn('点选头尾', () => {
                pick.tapMode = true;
                pick.selectedMark = null;
                clearNativeSelection();
                render();
            }, { ghost: true }),
            btn('清除', () => {
                pick.pendingRanges = [];
                pick.selectedMark = null;
                clearNativeSelection();
                render();
            }, { ghost: true, disabled: chars === 0 && !pick.selectedMark }));
        return bar;
    }

    function renderPickSurface(editor) {
        const pick = editor.pick;
        const listeners = editor.pickListeners;
        const surface = el('div', { class: `dga-pick-surface${pick.tapMode ? ' dga-tap-mode' : ''}` });

        // 按所有区间边界把正文切成小片，每片看归属决定底色。
        const marks = [];
        pickOwners(pick).forEach(owner => {
            owner.ranges.forEach(range => marks.push({ start: range.start, end: range.end, owner }));
        });
        const pending = normalizeRanges(pick.pendingRanges);
        const cuts = new Set([0, pick.text.length]);
        marks.forEach(mark => { cuts.add(mark.start); cuts.add(mark.end); });
        pending.forEach(range => { cuts.add(range.start); cuts.add(range.end); });
        if (pick.tapHead != null) cuts.add(pick.tapHead);
        const points = [...cuts].sort((left, right) => left - right);
        let caretPlaced = false;
        points.forEach((point, index) => {
            if (!caretPlaced && pick.tapHead === point) {
                surface.append(el('span', { class: 'dga-tap-caret', title: '开头' }));
                caretPlaced = true;
            }
            if (index >= points.length - 1) return;
            const end = points[index + 1];
            const mark = marks.find(item => item.start <= point && item.end >= end);
            const isPending = pending.some(range => range.start <= point && range.end >= end);
            const slice = pick.text.slice(point, end);
            if (!mark && !isPending) {
                surface.append(hostDocument().createTextNode(slice));
                return;
            }
            const classes = [];
            if (mark) {
                classes.push('dga-text-mark');
                if (mark.owner.id === pick.activeOwnerId) classes.push('is-active');
                if (pick.selectedMark && pick.selectedMark.ownerId === mark.owner.id
                    && pick.selectedMark.start === mark.start && pick.selectedMark.end === mark.end) {
                    classes.push('is-selected');
                }
            } else {
                classes.push('dga-pending');
            }
            if (isPending) classes.push('is-pending');
            surface.append(el('span', {
                class: classes.join(' '),
                style: mark ? { '--dga-c': mark.owner.color } : null,
                'data-owner': mark ? mark.owner.id : null,
                'data-s': String(point),
                'data-e': String(end),
            }, slice));
        });

        surface.addEventListener('mousedown', () => {
            if (listeners) listeners.gestureOpen = true;
        });
        surface.addEventListener('mouseup', () => {
            if (!listeners || !listeners.gestureOpen) return;
            listeners.gestureOpen = false;
            captureSelection(editor);
        });
        surface.addEventListener('click', event => {
            if (!listeners || Date.now() < listeners.ignoreClickUntil) return;
            if (pick.tapMode) {
                placeTapMarker(editor, offsetAtPoint(event.clientX, event.clientY));
                return;
            }
            const target = event.target;
            if (!target || !target.classList || !target.classList.contains('dga-text-mark')) return;
            const owner = pickOwner(pick, target.getAttribute('data-owner'));
            if (!owner) return;
            pick.activeOwnerId = owner.id;
            const start = Number(target.getAttribute('data-s'));
            const end = Number(target.getAttribute('data-e'));
            const mark = owner.ranges.find(range => range.start <= start && range.end >= end);
            pick.selectedMark = mark ? { ownerId: owner.id, start: mark.start, end: mark.end } : null;
            render();
        });
        surface.addEventListener('touchstart', event => {
            if (!listeners) return;
            listeners.touchActive = true;
            listeners.touchMoved = false;
            const touch = event.touches && event.touches[0];
            if (touch) { listeners.touchX = touch.clientX; listeners.touchY = touch.clientY; }
        }, { passive: true });
        surface.addEventListener('touchmove', event => {
            if (!listeners || !listeners.touchActive) return;
            const touch = event.touches && event.touches[0];
            if (touch && Math.hypot(touch.clientX - listeners.touchX, touch.clientY - listeners.touchY) > 12) listeners.touchMoved = true;
            if (pick.tapMode) clearNativeSelection();
        }, { passive: true });
        surface.addEventListener('touchend', event => {
            if (!listeners || !listeners.touchActive) return;
            listeners.touchActive = false;
            if (listeners.touchMoved) return;
            if (pick.tapMode) {
                const touch = event.changedTouches && event.changedTouches[0];
                if (touch) placeTapMarker(editor, offsetAtPoint(touch.clientX, touch.clientY));
                listeners.ignoreClickUntil = Date.now() + 500;
                return;
            }
            // 系统拖把手选区在手指抬起后才定形，延迟一轮再读取。
            hostWindow.setTimeout(() => captureSelection(editor), 0);
        });
        surface.addEventListener('touchcancel', () => {
            if (listeners) listeners.touchActive = false;
        });
        return surface;
    }

    function renderPickSide(editor) {
        const pick = editor.pick;
        const refs = { chipNames: {} };
        editor.pickRefs = refs;
        const chips = el('div', { class: 'dga-pick-chips' });
        [...sortedStages(pick), ...pick.addons, pick.always, pick.note].forEach(owner => {
            const chars = owner.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
            const nameNode = el('span', { class: 'dga-chip-name', text: owner.name });
            refs.chipNames[owner.id] = nameNode;
            chips.append(el('button', {
                type: 'button',
                class: `dga-chip${owner.id === pick.activeOwnerId ? ' is-on' : ''}`,
                style: { '--dga-c': owner.color },
                onclick: () => {
                    pick.activeOwnerId = owner.id;
                    pick.selectedMark = null;
                    render();
                },
            },
                el('span', { class: 'dga-chip-dot' }),
                nameNode,
                el('span', { class: 'dga-chip-count', text: chars > 0 ? `${chars} 字` : '空' })));
        });
        chips.append(el('button', { type: 'button', class: 'dga-chip dga-chip-add', onclick: () => pickNewOwner(editor, 'stage') }, '+ 阶段'));
        chips.append(el('button', { type: 'button', class: 'dga-chip dga-chip-add', onclick: () => pickNewOwner(editor, 'addon') }, '+ 附加'));
        return el('div', { class: 'dga-pick-side' }, chips, renderPickSettings(editor));
    }

    function renderPickSettings(editor) {
        const pick = editor.pick;
        const owner = pickOwner(pick, pick.activeOwnerId);
        if (!owner) return null;
        if (owner.kind === 'always') {
            return el('div', { class: 'dga-pick-settings' },
                muted('常驻提示：每一段都会发给 AI。把文字分配到这里即可。'),
                btn(pick.alwaysTop ? '位置：排在阶段内容之前（点我改到之后）' : '位置：排在阶段内容之后（点我改到之前）', () => {
                    pick.alwaysTop = !pick.alwaysTop;
                    pick.stale = true;
                    render();
                }, { ghost: true }));
        }
        if (owner.kind === 'note') {
            return el('div', { class: 'dga-pick-settings' }, muted('备注：只给自己看，不会发给 AI。把文字分配到这里即可。'));
        }
        const box = el('div', { class: 'dga-pick-settings' });
        const nameInput = el('input', { type: 'text', maxlength: 60 });
        nameInput.value = owner.name;
        // 改名不重建正文，只记“待重建”，打字不会丢焦点。
        nameInput.addEventListener('input', event => {
            owner.name = event.target.value.replace(/[#【】\[\]]/g, '');
            pick.stale = true;
            const label = editor.pickRefs && editor.pickRefs.chipNames[owner.id];
            if (label) label.textContent = owner.name.trim() || '（未命名）';
        });
        box.append(field('名称', nameInput));

        if (owner.kind === 'stage') {
            const completion = el('textarea', {
                rows: 2,
                placeholder: '例如：两人完成第一次正式交谈。留空就只能手动点“下一段”。',
            });
            completion.value = owner.completion;
            completion.addEventListener('input', event => {
                owner.completion = event.target.value;
                pick.stale = true;
            });
            box.append(field('什么时候进入下一段（AI 自己判断）', completion));
        } else {
            const sorted = sortedStages(pick);
            const options = sorted.map((stage, index) => ({ value: stage.name, label: `第 ${index + 1} 段 · ${stage.name}` }));
            if (options.length === 0) {
                box.append(muted('还没有剧情阶段。先点“+ 阶段”，再给附加内容选生效范围。'));
            } else {
                if (!options.some(option => option.value === owner.from)) owner.from = options[0].value;
                if (!options.some(option => option.value === owner.to)) owner.to = owner.from;
                box.append(field('从哪一段开始有效', selectControl(options, owner.from, value => {
                    owner.from = value;
                    pick.stale = true;
                })));
                box.append(field('到哪一段为止（含这一段）', selectControl(options, owner.to, value => {
                    owner.to = value;
                    pick.stale = true;
                })));
            }
        }
        box.append(el('div', { class: 'dga-row' },
            btn(owner.kind === 'stage' ? '删除这个阶段' : '删除这个附加', () => pickDeleteOwner(editor, owner), { danger: true })));
        return box;
    }

    async function saveEditor(bindAfter) {
        const editor = ui.editor;
        const wasPick = editor.mode === 'pick' && editor.pick;
        if (wasPick && editor.pick.stale) {
            editor.lines = normalizeText(pickBuild(editor.pick)).split('\n');
        }
        const content = editor.lines.join('\n');
        const parsed = parseOutline(content);
        if (bindAfter && parsed.stages.length === 0) {
            throw new Error('还没有剧情阶段，不能添加。先点一个段落，把它设为第一阶段的开头。');
        }
        const saved = await writeEntryContent(editor.worldbookName, editor.entry.uid, entryName(editor.entry), content);
        editor.entry = saved;
        editor.lines = normalizeText(saved.content).split('\n');
        editor.parsed = parseOutline(saved.content);
        editor.dirty = false;
        if (bindAfter) {
            await addBinding(editor.worldbookName, saved, { confirm: false });
            ui.view = 'manager';
            discardEditor();
            await refresh({ worldbookName: editor.worldbookName, entryKey: entryKey(saved, 0) });
            setMessage('已保存并添加。当前聊天从第一段开始。', 'success');
            return;
        }
        // 已添加的条目：保存后立刻按新正文重新注入，进度按阶段名自动对上。
        if (editor.bound) await injectCurrentGuide('normal');
        // 留在选区模式：按保存后的正文重新铺开，待分配的预览不保留。
        if (wasPick) {
            pickDetach(editor);
            editor.pick = pickLoad(editor.parsed);
            pickAttach(editor);
            editor.mode = 'pick';
        }
        setMessage(editor.bound ? '已保存，进度按阶段名自动对上。' : '已保存。正文只增减了标题行。', 'success');
    }

    // ---------------------------------------------------------------
    // 三、界面：样式
    // ---------------------------------------------------------------

    function styles() {
        const P = `#${PANEL_ID}`;
        return `
${P} { position: fixed; top: 0; left: 0; right: 0; width: auto; height: 100vh; height: 100dvh; max-height: 100dvh; overflow: hidden; z-index: 100000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(6, 8, 14, 0.62); backdrop-filter: blur(4px); color: var(--SmartThemeBodyColor, #ececf1); font-size: 15px; line-height: 1.55; box-sizing: border-box; }
${P}[hidden] { display: none; }
${P} *, ${P} *::before, ${P} *::after { box-sizing: border-box; }
${P} .dga-shell { position: relative; display: flex; flex-direction: column; width: 100%; max-width: 720px; max-height: 100%; background: var(--SmartThemeBlurTintColor, #1b1d24); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 18px; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5); overflow: hidden; outline: none; }
${P} .dga-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
${P} .dga-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
${P} .dga-head h2 { margin: 0; font-size: 1.12rem; }
${P} .dga-head small { opacity: 0.65; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${P} .dga-close { flex: 0 0 auto; min-width: 44px; padding: 8px 12px; }
${P} .dga-body { flex: 1 1 auto; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 12px; }
${P} .dga-foot { display: flex; gap: 10px; padding: 12px 16px; border-top: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.12); }
${P} .dga-foot .dga-btn { flex: 1 1 0; }
${P} .dga-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.08); }
${P} .dga-card h3 { margin: 0; font-size: 0.9rem; font-weight: 600; opacity: 0.75; }
${P} .dga-big { font-size: 1.45rem; font-weight: 700; line-height: 1.25; }
${P} .dga-stage-name { font-size: 1.05rem; font-weight: 600; color: var(--SmartThemeQuoteColor, #b8a7ff); overflow-wrap: anywhere; }
${P} .dga-muted, ${P} .dga-help { margin: 0; font-size: 0.88rem; opacity: 0.7; }
${P} .dga-bound-head { display: flex; align-items: center; gap: 10px; }
${P} .dga-bound-head .dga-heading-text { flex: 1 1 auto; }
${P} .dga-row { display: flex; gap: 8px; flex-wrap: wrap; }
${P} .dga-row > .dga-btn { flex: 1 1 30%; }
${P} .dga-btn { min-height: 44px; padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.07); color: inherit; font: inherit; font-weight: 600; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-btn:hover { background: rgba(255, 255, 255, 0.12); }
${P} .dga-btn:disabled { opacity: 0.4; cursor: default; }
${P} .dga-btn.dga-primary { background: var(--SmartThemeQuoteColor, #7c6cf0); border-color: transparent; color: #fff; }
${P} .dga-btn.dga-danger { color: #ff9b9b; border-color: rgba(255, 120, 120, 0.35); }
${P} .dga-btn.dga-ghost { background: transparent; }
${P} .dga-field { display: flex; flex-direction: column; gap: 5px; font-size: 0.88rem; }
${P} .dga-field > span { opacity: 0.8; }
${P} select, ${P} input[type="text"], ${P} textarea { width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 11px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(0, 0, 0, 0.26); color: inherit; font: inherit; }
${P} textarea { min-height: 72px; resize: vertical; }
${P} .dga-check { display: flex; align-items: center; gap: 10px; font-size: 0.9rem; }
${P} .dga-check input { width: 20px; height: 20px; }
${P} .dga-msg { padding: 10px 12px; border-radius: 11px; font-size: 0.9rem; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(110, 140, 255, 0.14); border: 1px solid rgba(110, 140, 255, 0.32); }
${P} .dga-msg[data-type="success"] { background: rgba(60, 190, 120, 0.14); border-color: rgba(60, 190, 120, 0.35); }
${P} .dga-msg[data-type="warning"] { background: rgba(245, 170, 50, 0.14); border-color: rgba(245, 170, 50, 0.38); }
${P} .dga-msg[data-type="error"] { background: rgba(240, 80, 80, 0.14); border-color: rgba(240, 80, 80, 0.4); }
${P} .dga-pre { margin: 0; padding: 10px 12px; border-radius: 11px; background: rgba(0, 0, 0, 0.28); font: inherit; font-size: 0.88rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; }
${P} .dga-fold > summary { cursor: pointer; font-weight: 600; list-style: none; padding: 2px 0; }
${P} .dga-fold > summary::-webkit-details-marker { display: none; }
${P} .dga-fold > summary::after { content: ' ▾'; opacity: 0.6; }
${P} .dga-fold[open] > summary::after { content: ' ▴'; }
${P} .dga-fold > *:not(summary) { margin-top: 10px; }
${P} .dga-steps { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 6px; }
${P} .dga-doc { display: flex; flex-direction: column; gap: 8px; }
${P} .dga-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
${P} .dga-toolbar .dga-btn { flex: 0 0 auto; min-height: 40px; padding: 8px 12px; }
${P} .dga-toolbar .dga-muted { flex: 1 1 auto; opacity: 0.55; }
${P} textarea.dga-raw { min-height: 46vh; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92rem; line-height: 1.5; }
${P} .dga-para { padding: 11px 13px; border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.03); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.93rem; cursor: pointer; }
${P} .dga-para:hover, ${P} .dga-para:focus-visible, ${P} .dga-heading:hover, ${P} .dga-heading:focus-visible { outline: 2px solid var(--SmartThemeQuoteColor, #7c6cf0); outline-offset: 1px; }
${P} .dga-para.dga-dim { opacity: 0.5; }
${P} .dga-heading { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 10px 12px; border-radius: 12px; border-left: 5px solid var(--dga-c, #8b5cf6); background: color-mix(in srgb, var(--dga-c, #8b5cf6) 18%, transparent); cursor: pointer; }
${P} .dga-heading-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
${P} .dga-heading b { font-size: 1rem; overflow-wrap: anywhere; }
${P} .dga-heading small { opacity: 0.75; font-size: 0.8rem; overflow-wrap: anywhere; }
${P} .dga-tag { flex: 0 0 auto; padding: 2px 9px; border-radius: 999px; background: var(--dga-c, #8b5cf6); color: #fff; font-size: 0.75rem; font-weight: 700; white-space: nowrap; }
${P} .dga-chev { opacity: 0.5; font-size: 1.3rem; }
${P} .dga-move-wrap { display: flex; flex-direction: column; gap: 3px; flex: 0 0 auto; }
${P} .dga-move { width: 32px; min-height: 26px; padding: 0; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.06); color: inherit; font: inherit; font-size: 0.82rem; line-height: 1; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-move:hover { background: rgba(255, 255, 255, 0.14); }
${P} .dga-move:disabled { opacity: 0.25; cursor: default; }
${P} .dga-hint { margin: 4px 0 0; text-align: center; font-size: 0.82rem; opacity: 0.6; }
${P} .dga-seg { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
${P} .dga-seg-btn { min-height: 40px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.05); color: inherit; font: inherit; cursor: pointer; }
${P} .dga-seg-btn.is-on { background: var(--SmartThemeQuoteColor, #7c6cf0); border-color: transparent; color: #fff; font-weight: 700; }
${P} .dga-sheet-bg { position: absolute; inset: 0; z-index: 2; display: flex; align-items: flex-end; justify-content: center; background: rgba(0, 0, 0, 0.55); }
${P} .dga-sheet { width: 100%; max-height: 88%; overflow: auto; padding: 16px 16px 20px; border-radius: 18px 18px 0 0; background: var(--SmartThemeBlurTintColor, #1b1d24); border-top: 1px solid rgba(255, 255, 255, 0.14); display: flex; flex-direction: column; gap: 12px; }
${P} .dga-sheet h3 { margin: 0; font-size: 1.05rem; }
${P} .dga-sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; }
${P} .dga-sheet-actions .dga-btn { flex: 1 1 40%; }
${P} .dga-busy .dga-body, ${P} .dga-busy .dga-foot { opacity: 0.6; pointer-events: none; }
#${MENU_ITEM_ID} { width: 100%; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-seg.dga-mode-seg { flex: 1 1 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
${P} .dga-pick { display: flex; flex-direction: column; gap: 10px; }
${P} .dga-pick-side { display: flex; flex-direction: column; gap: 8px; }
${P} .dga-pick-chips { display: flex; flex-wrap: wrap; gap: 6px; }
${P} .dga-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 6px 11px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.05); color: inherit; font: inherit; font-size: 0.86rem; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-chip.is-on { border-color: var(--dga-c, #8b5cf6); background: color-mix(in srgb, var(--dga-c, #8b5cf6) 24%, transparent); font-weight: 700; }
${P} .dga-chip-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dga-c, #8b5cf6); flex: 0 0 auto; }
${P} .dga-chip-count { opacity: 0.6; font-size: 0.78rem; }
${P} .dga-chip-add { border-style: dashed; opacity: 0.85; }
${P} .dga-pick-settings { display: flex; flex-direction: column; gap: 9px; padding: 11px 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); }
${P} .dga-pick-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; gap: 7px; padding: 8px 9px; border-radius: 12px; background: var(--SmartThemeBlurTintColor, #1b1d24); border: 1px solid rgba(255, 255, 255, 0.14); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3); }
${P} .dga-pick-bar .dga-btn { flex: 0 0 auto; min-height: 38px; padding: 7px 12px; font-size: 0.87rem; }
${P} .dga-pick-bar-text { flex: 1 1 100%; font-size: 0.86rem; opacity: 0.78; }
${P} .dga-pick-surface { padding: 12px 13px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.18); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.95rem; line-height: 1.75; user-select: text; -webkit-user-select: text; cursor: text; }
${P} .dga-pick-surface.dga-tap-mode { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: pointer; }
${P} .dga-text-mark { padding: 1px 0; border-radius: 4px; background: color-mix(in srgb, var(--dga-c, #8b5cf6) 24%, transparent); box-decoration-break: clone; -webkit-box-decoration-break: clone; cursor: pointer; }
${P} .dga-text-mark.is-active { background: color-mix(in srgb, var(--dga-c, #8b5cf6) 44%, transparent); box-shadow: 0 0 0 1px var(--dga-c, #8b5cf6); }
${P} .dga-text-mark.is-selected { outline: 2px solid rgba(255, 255, 255, 0.9); outline-offset: 1px; }
${P} .dga-pending { border-bottom: 2px dashed rgba(255, 255, 255, 0.75); }
${P} .dga-text-mark.is-pending, ${P} .dga-pending { background: rgba(255, 255, 255, 0.14); }
${P} .dga-tap-caret { display: inline-block; width: 0; height: 1.15em; vertical-align: -0.2em; border-left: 2px solid #ffd166; position: relative; }
${P} .dga-tap-caret::after { content: '开头'; position: absolute; top: -1.4em; left: -3px; padding: 0 5px; border-radius: 4px; background: #ffd166; color: #221a00; font-size: 0.7rem; line-height: 1.5; white-space: nowrap; }
@media (max-width: 680px) {
    ${P} { padding: 0; }
    ${P} .dga-shell { max-width: none; height: 100%; max-height: none; border-radius: 0; border: 0; }
}
@media (min-width: 681px) {
    ${P} .dga-sheet-bg { align-items: center; padding: 20px; }
    ${P} .dga-sheet { max-width: 520px; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.14); }
    ${P} .dga-seg { grid-template-columns: repeat(4, 1fr); }
}`;
    }

    // ---------------------------------------------------------------
    // 三、界面：入口、菜单、事件
    // ---------------------------------------------------------------

    function closeExtensionsMenu() {
        const doc = hostDocument();
        if (!doc) return;
        const menu = getWandMenu(doc);
        const button = doc.getElementById('extensionsMenuButton');
        if (!menu || !button) return;
        try {
            const view = doc.defaultView || hostWindow;
            const style = view.getComputedStyle(menu);
            if (style.display !== 'none' && style.visibility !== 'hidden') button.click();
        } catch (error) {
            button.click();
        }
    }

    async function openManager() {
        const panel = ensurePanel();
        if (!panel) throw new Error('页面还没准备好，请稍后再试。');
        fitPanelForTouch(panel);
        ui.view = 'manager';
        discardEditor();
        render();
        panel.hidden = false;
        // 面板先同步显示，再收起酒馆菜单。这样手机触摸结束时即使菜单重绘，
        // 也不会把“打开管理页”留到下一轮任务才执行。
        closeExtensionsMenu();
        await runAction('读取状态', async () => {});
        const shell = panel.querySelector('.dga-shell');
        if (shell) shell.focus();
    }

    // 手机端保证整屏显示：即使主题或客户端漏掉 viewport 设置，也不出现缩在中间的小窗。
    function fitPanelForTouch(panel) {
        const view = (panel.ownerDocument && panel.ownerDocument.defaultView) || hostWindow;
        let coarse = false;
        try {
            coarse = Boolean(view.matchMedia && view.matchMedia('(pointer: coarse)').matches);
        } catch (error) {
            coarse = false;
        }
        const width = view.innerWidth || 0;
        const height = view.innerHeight || 0;
        const narrow = width > 0 && Math.min(width, height) <= 900;
        if (!coarse && !narrow) return;
        panel.style.setProperty('padding', '0');
        const shell = panel.querySelector('.dga-shell');
        if (!shell) return;
        shell.style.setProperty('max-width', 'none');
        shell.style.setProperty('height', '100%');
        shell.style.setProperty('max-height', 'none');
        shell.style.setProperty('border-radius', '0');
    }

    function removeNode(node) {
        if (!node) return;
        if (typeof node.remove === 'function') node.remove();
        else if (node.parentNode) node.parentNode.removeChild(node);
    }

    function removeStaleUi() {
        windowCandidates.forEach(candidate => {
            let doc;
            try { doc = candidate.document; } catch (error) { return; }
            if (!doc) return;
            removeNode(doc.getElementById(MENU_ITEM_ID));
            removeNode(doc.getElementById(LEGACY_MENU_CONTAINER_ID));
            removeNode(doc.getElementById(PANEL_ID));
            removeNode(doc.getElementById(STYLE_ID));
        });
    }

    function registerMenuEntry(retry) {
        if (!isCurrentInstance()) return;
        const doc = hostDocument();
        if (!doc) return;
        const menu = getWandMenu(doc);
        if (!doc.body || !menu) {
            if ((retry || 0) < 30) {
                hostWindow.setTimeout(() => registerMenuEntry((retry || 0) + 1), 1000);
            } else {
                reportOnce('menu', '找不到酒馆左下角的魔法棒菜单，没能添加“动态指导助手”入口。');
            }
            return;
        }
        ensureStyle(doc);
        removeNode(doc.getElementById(MENU_ITEM_ID));
        removeNode(doc.getElementById(LEGACY_MENU_CONTAINER_ID));
        // 和酒馆自带条目、酒馆助手工具箱用同一套结构：
        // #extensionsMenu > .extension_container > div，图标也是 div。
        // 主题里 ".options-content a"、"#extensionsMenu>.extension_container>div"
        // 这些规则才会命中，入口不会变成样式走样的按钮。
        const item = doc.createElement('div');
        item.id = MENU_ITEM_ID;
        item.className = 'extension_container';
        const row = doc.createElement('div');
        row.className = 'list-group-item flex-container flexGap5 interactable';
        row.tabIndex = 0;
        row.setAttribute('role', 'listitem');
        row.title = '打开动态指导助手';
        const icon = doc.createElement('div');
        icon.className = 'fa-fw fa-solid fa-book-open extensionsMenuExtensionButton';
        const label = doc.createElement('span');
        label.textContent = '动态指导助手';
        row.append(icon, label);
        item.append(row);
        let lastOpen = 0;
        const openFromMenu = event => {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            const now = Date.now();
            if (now - lastOpen < 600) return;
            lastOpen = now;
            runEventTask('打开管理页', openManager);
        };
        item.onclick = openFromMenu;
        item.addEventListener('pointerup', openFromMenu);
        // 旧 Android WebView 没有 PointerEvent 时，接一次触摸结束兜底。
        item.addEventListener('touchend', openFromMenu, { passive: false });
        menu.appendChild(item);
    }

    function runEventTask(label, task) {
        if (!isCurrentInstance()) return Promise.resolve();
        try {
            // 先同步调用 task，让菜单点击可以立即把面板显示出来。
            return Promise.resolve(task()).catch(error => {
                console.error(`[${SCRIPT_NAME}] ${label}失败`, error);
                reportOnce(label, `${label}失败：${error.message || String(error)}`);
            });
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] ${label}失败`, error);
            reportOnce(label, `${label}失败：${error.message || String(error)}`);
            return Promise.resolve();
        }
    }

    // 快捷指令只操作第一条能用的绑定；多条绑定时请用管理页逐张卡片操作。
    async function shiftStage(delta) {
        try {
            const context = await requireContext();
            await moveToIndex(context, context.state.stageIndex + delta);
        } catch (error) {
            notify(error.message || String(error), 'error');
        }
    }

    const next = () => shiftStage(1);
    const previous = () => shiftStage(-1);

    async function reset() {
        try {
            const context = await requireContext();
            if (!hostWindow.confirm('把这个聊天的进度重置到第一段？')) return;
            await moveToIndex(context, 0);
        } catch (error) {
            notify(error.message || String(error), 'error');
        }
    }

    const publicApi = {
        version: VERSION,
        parseOutline,
        activeAddons,
        formatInjection,
        reconcileState,
        insertHeading,
        replaceHeading,
        deleteHeading,
        moveBlock,
        autoSplitByBlankLines,
        readLegacyLayout,
        convertLegacyLayout,
        normalizeRanges,
        pickLoad,
        pickBuild,
        pickAssign,
        pickRemove,
        openEditorAt,
        openManager,
        refresh: () => runAction('刷新', async () => {}),
        next,
        previous,
        reset,
        add: (worldbookName, entry, options) => addBinding(worldbookName, entry, options),
        unbind: (key, options) => unbindEntry(key, options),
        getCurrentSnapshot: loadContexts,
    };
    currentWindow.DynamicGuideAssistantCore = publicApi;

    if (!helper) {
        console.warn(`[${SCRIPT_NAME}] 未检测到酒馆助手；只开放解析函数。`);
        return;
    }

    removeStaleUi();
    registerMenuEntry(0);
    // 页面一打开就把当前阶段准备好：第一次生成同样不用等异步读取。
    runEventTask('准备注入', () => injectCurrentGuide('startup'));

    const eventOn = api('eventOn', false);
    const events = apiValue('tavern_events');
    if (!eventOn || !events) {
        reportOnce('events', '当前酒馆助手缺少事件接口，管理页可以用，但无法自动注入内容。');
        return;
    }
    if (events.GENERATION_AFTER_COMMANDS) {
        eventOn(events.GENERATION_AFTER_COMMANDS, function (type, params, dryRun) {
            if (dryRun === true) return;
            // SillyTavern 会等待这个事件监听器返回的 Promise。必须把注入任务返回，
            // 否则世界书读取尚未完成，请求就已经继续组装，当前阶段会从提示词中消失。
            return runEventTask('注入当前阶段', () => injectCurrentGuide(type));
        });
    }
    if (events.MESSAGE_RECEIVED) {
        eventOn(events.MESSAGE_RECEIVED, function () {
            const args = arguments;
            return runEventTask('处理完成标记', () => handleMessageReceived.apply(null, args));
        });
    }
    if (events.CHAT_CHANGED) {
        eventOn(events.CHAT_CHANGED, () => runEventTask('切换聊天', async () => {
            // 换聊天后进度不同：先丢掉缓存和旧注入，再按读到的状态重新注入。
            // 注入按聊天文件隔离，即使新聊天阶段内容相同也要重新注入，所以缓存也要清掉。
            injectionCache.all = null;
            await clearAllInjections();
            await injectCurrentGuide('normal');
            const doc = hostDocument();
            const panel = doc && doc.getElementById(PANEL_ID);
            if (panel && !panel.hidden) await runAction('刷新', async () => {});
        }));
    }
})();
