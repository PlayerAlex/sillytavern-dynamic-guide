(function () {
    'use strict';

    /* ================================================================
     * 动态指导助手 v2.22
     *
     * 这个文件分三部分：
     *   一、核心：纯函数与独立模块。把世界书正文解析成阶段，按进度挑出要发的
     *       内容；选区划分也在这里做载入和重建。运行日志（LogModule）与
     *       边界规则（RuleModule）是两个零依赖的内部模块，仿数据库
     *       （shujuku）的 log-buffer.ts / utils.ts 拆分。不碰页面，不碰
     *       酒馆接口，可以单独测试。
     *   二、适配层：读写酒馆助手的变量、世界书和事件；在同一本世界书里
     *       维护「（动态指导）」镜像条目，把当前阶段显示在原条目的位置。
     *   三、界面：管理页和“划分阶段”编辑器（看分段 / 选区划分 / 编辑原文）。
     *
     * 可以同时绑定好几个大纲条目：每个条目被关闭后，插件在同一本世界书里
     * 克隆出一个镜像条目——位置、顺序、关键词等设置全部跟随原条目，只有
     * 当前阶段的切片作为内容，相当于暂时让其余内容不被 AI 看到。
     *
     * 数据分三类存储：
     *   - 阶段结构就是世界书条目正文本身，用标题行（## 名称）分段。
     *   - 绑定列表存在角色变量里；每个绑定的进度按绑定分开存在聊天变量里。
     *   - API 预设存在当前浏览器 localStorage，不随角色卡导出。
     * ================================================================ */

    // ---------------------------------------------------------------
    // 一、核心：常量与文本工具
    // ---------------------------------------------------------------

    const SCRIPT_NAME = '动态指导助手';
    const VERSION = '2.22';
    const VARIABLE_ROOT = '$dynamicGuideAssistant';
    const INJECTION_ID = 'dynamic-guide-assistant-current';
    const INSTANCE_KEY = '__dynamicGuideAssistantInstance';
    const UI_PREFIX = 'dynamic-guide-assistant';
    const PANEL_ID = `${UI_PREFIX}-panel`;
    const STYLE_ID = `${UI_PREFIX}-style`;
    const MENU_ITEM_ID = `${UI_PREFIX}-menu-item`;
    const LEGACY_MENU_CONTAINER_ID = `${UI_PREFIX}-menu-container`;
    const COMPLETE_MARKER_RE = /<!--\s*DGA_COMPLETE:([a-z0-9_-]+)\s*-->/gi;
    const JUDGE_PRESET_STORAGE_KEY = 'dynamic-guide-assistant:judge-api-presets:v1';

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

    // ---------------------------------------------------------------
    // 一、核心：运行日志模块（仿数据库 shujuku shared/log-buffer.ts）
    //
    // 零 DOM 依赖的内存环形缓冲：等级 debug / info / warn / error，全部写入
    // 缓冲（debug 默认不采集，运行日志页可开）。每条带时间戳、模块标签、消息；
    // 订阅机制让日志页打开时实时刷新。只存内存（上限 500 条），不写变量、
    // 不上传；console 输出仍由各调用点自己负责，模块本身不产生副作用。
    // ---------------------------------------------------------------

    const LogModule = (() => {
        const MAX_ENTRIES = 500;
        let entries = [];
        let nextId = 1;
        let debugEnabled = false;
        const knownTags = new Set();
        const subscribers = new Set();

        function stringify(value) {
            if (value == null) return String(value);
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (value instanceof Error || (value && typeof value.message === 'string')) {
                return `${value.name || 'Error'}: ${value.message}`;
            }
            try {
                return JSON.stringify(value);
            } catch (error) {
                return String(value);
            }
        }

        function push(level, tag, args) {
            if (level === 'debug' && !debugEnabled) return;
            const entry = {
                id: nextId++,
                time: Date.now(),
                level,
                tag: tag || '未分类',
                message: args.map(stringify).join(' '),
            };
            entries.push(entry);
            if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
            knownTags.add(entry.tag);
            subscribers.forEach(notifySubscriber => {
                try {
                    notifySubscriber(entry);
                } catch (error) {
                    // 订阅者出错不影响日志本身。
                }
            });
        }

        return {
            debug: (tag, ...args) => push('debug', tag, args),
            info: (tag, ...args) => push('info', tag, args),
            warn: (tag, ...args) => push('warn', tag, args),
            error: (tag, ...args) => push('error', tag, args),
            list: () => entries.slice(),
            count: () => entries.length,
            clear: () => { entries = []; },
            tags: () => Array.from(knownTags).sort(),
            subscribe: notifySubscriber => {
                subscribers.add(notifySubscriber);
                return () => subscribers.delete(notifySubscriber);
            },
            setDebugEnabled: value => { debugEnabled = Boolean(value); },
            isDebugEnabled: () => debugEnabled,
            _resetForTesting: () => {
                entries = [];
                nextId = 1;
                debugEnabled = false;
                knownTags.clear();
                subscribers.clear();
            },
        };
    })();

    // ---------------------------------------------------------------
    // 一、核心：边界规则模块（复刻数据库 shujuku AcuRulePairList / utils.ts）
    //
    // 每条规则是一对边界 {start, end}，匹配不区分大小写：
    //   提取规则：每条规则取「最后一个结束边界 + 它之前最后一个开始边界」，
    //     含边界本身截取；多条规则的结果用空行拼接；一条都没命中就返回原文。
    //   排除规则：删掉所有「开始边界~结束边界」区间（含边界本身，支持嵌套，
    //     重叠自动合并），最后把 3 个以上连续换行压成 2 个并 trim。
    //   组合顺序与数据库一致：先提取、后排除。规则为空 = 原文直通。
    // 用途：先削掉判断AI输出里的思维链/闲聊，再解析 <结论> 标签。
    // ---------------------------------------------------------------

    const RuleModule = (() => {
        function normalize(raw) {
            const list = Array.isArray(raw) ? raw : [];
            const seen = new Set();
            const rules = [];
            list.forEach(item => {
                if (!item || typeof item !== 'object') return;
                const start = String(item.start == null ? '' : item.start).trim();
                const end = String(item.end == null ? '' : item.end).trim();
                if (!start || !end) return;
                const key = `${start}\u0000${end}`;
                if (seen.has(key)) return;
                seen.add(key);
                rules.push({ start, end });
            });
            return rules;
        }

        function removeAllMatched(text, startBoundary, endBoundary) {
            const source = String(text == null ? '' : text);
            const start = String(startBoundary || '');
            const end = String(endBoundary || '');
            if (!source || !start || !end) return source;
            const lowerSource = source.toLowerCase();
            const lowerStart = start.toLowerCase();
            const lowerEnd = end.toLowerCase();
            const openStarts = [];
            const ranges = [];
            let cursor = 0;
            while (cursor < lowerSource.length) {
                const startIndex = lowerSource.indexOf(lowerStart, cursor);
                const endIndex = lowerSource.indexOf(lowerEnd, cursor);
                if (startIndex === -1 && endIndex === -1) break;
                if (startIndex !== -1 && (endIndex === -1 || startIndex <= endIndex)) {
                    openStarts.push(startIndex);
                    cursor = startIndex + lowerStart.length;
                    continue;
                }
                if (openStarts.length) {
                    const from = openStarts.pop();
                    const to = endIndex + lowerEnd.length;
                    if (to > from) ranges.push({ from, to });
                }
                cursor = endIndex + lowerEnd.length;
            }
            if (!ranges.length) return source;
            ranges.sort((left, right) => left.from - right.from || left.to - right.to);
            const merged = [];
            ranges.forEach(range => {
                const last = merged[merged.length - 1];
                if (!last || range.from > last.to) merged.push({ ...range });
                else last.to = Math.max(last.to, range.to);
            });
            let result = source;
            for (let index = merged.length - 1; index >= 0; index -= 1) {
                result = result.slice(0, merged[index].from) + result.slice(merged[index].to);
            }
            return result;
        }

        function extractLastMatched(text, startBoundary, endBoundary) {
            const source = String(text == null ? '' : text);
            const start = String(startBoundary || '');
            const end = String(endBoundary || '');
            if (!source || !start || !end) return null;
            const lowerSource = source.toLowerCase();
            const lowerStart = start.toLowerCase();
            const lowerEnd = end.toLowerCase();
            const endIndex = lowerSource.lastIndexOf(lowerEnd);
            if (endIndex === -1) return null;
            const startIndex = lowerSource.lastIndexOf(lowerStart, Math.max(0, endIndex - 1));
            if (startIndex === -1) return null;
            const to = endIndex + end.length;
            if (to <= startIndex) return null;
            return source.slice(startIndex, to);
        }

        function applyExtract(text, rawRules) {
            const source = String(text == null ? '' : text);
            const rules = normalize(rawRules);
            if (!source || !rules.length) return source;
            const parts = rules
                .map(rule => extractLastMatched(source, rule.start, rule.end))
                .filter(part => part != null);
            return parts.length ? parts.join('\n\n') : source;
        }

        function applyExclude(text, rawRules) {
            let result = String(text == null ? '' : text);
            const rules = normalize(rawRules);
            if (!result || !rules.length) return result;
            rules.forEach(rule => {
                result = removeAllMatched(result, rule.start, rule.end);
            });
            return result.replace(/\n{3,}/g, '\n\n').trim();
        }

        function apply(text, options) {
            const settings = options || {};
            return applyExclude(applyExtract(text, settings.extractRules), settings.excludeRules);
        }

        return { normalize, applyExtract, applyExclude, apply };
    })();

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
                const rawCompletion = String(item.labels.completion || item.labels.to || '').trim();
                // “完成：自动”表示这个阶段不预设具体条件，交给 AI 自己判断该不该进入下一段。
                item.autoComplete = /^(自动|自动判断|auto)$/i.test(rawCompletion);
                item.completion = item.autoComplete ? '' : rawCompletion;
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

    // 完成判定块：有 completion 就用用户写的条件；否则 auto 档给一段通用判断指令。
    // 两种都在回复末尾要同一行隐藏标记，handleMessageReceived 识别后推进。
    function completionInstruction(stage, auto) {
        if (!stage) return [];
        const marker = `<!-- DGA_COMPLETE:${stage.id} -->`;
        if (stage.completion) {
            return [
                '',
                '## 当前阶段的完成判定',
                stage.completion,
                '',
                '只有当你确信本次回复已经实际完成上述判定时，才在回复末尾原样附加下面这行 HTML 注释；尚未完成时不要附加：',
                marker,
            ];
        }
        if (auto) {
            return [
                '',
                '## 进入下一段的时机',
                '当前阶段没有预设完成条件：当你判断这一阶段的内容已经充分展开、剧情自然该进入下一段时，在回复末尾原样附加下面这行 HTML 注释；还不该走时绝对不要附加：',
                marker,
            ];
        }
        return [];
    }

    function formatInjection(stage, addons, options) {
        if (!stage) return '';
        const auto = Boolean(options && options.auto);
        // 写在所有阶段之前的常驻排在最前面，其余附加/常驻按正文顺序放在阶段之后。
        // 不要加任何插件头部或解释文字：这份内容会原样出现在镜像条目里，
        // 用户在提示词查看器里看到的就是大纲正文本身。
        const above = addons.filter(item => item.kind === 'always' && item.aboveStages);
        const below = addons.filter(item => !above.includes(item));
        const lines = [];
        if (above.length > 0) {
            lines.push('## 常驻提示');
            above.forEach(item => lines.push('', `### ${item.name}`, item.prompt));
            lines.push('');
        }
        lines.push(`## 当前阶段：${stage.name}`, stage.prompt);
        if (below.length > 0) {
            lines.push('', '## 同时有效的附加内容');
            below.forEach(item => lines.push('', `### ${item.name}`, item.prompt));
        }
        lines.push(...completionInstruction(stage, auto || stage.autoComplete));
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
            lastJudgeCheckedId: old.lastJudgeCheckedId == null ? null : old.lastJudgeCheckedId,
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
            completion: block.autoComplete ? '自动' : (block.completion || ''),
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
        LogModule.warn('提醒', message);
        notify(message, 'warning');
    }

    // ---------------------------------------------------------------
    // 二、适配层：API 预设（浏览器本地存储）
    //
    // 完整预设可能含 API Key，绝不能写角色/聊天变量（会随角色卡或聊天数据传播）。
    // 因此预设实体只存在当前浏览器同源 localStorage；角色 config 只保存当前选择名。
    // ---------------------------------------------------------------

    // 提示词后处理（对齐 shujuku 与酒馆「提示词后处理」下拉）：'' = 未选择（不带该字段原样透传）；
    // 缺失/非法值归一为 'strict'（与历史写死 strict 的行为兼容）。
    const PROMPT_POST_PROCESSING_VALUES = ['', 'merge', 'semi', 'strict', 'single', 'merge_tools', 'semi_tools', 'strict_tools'];
    function normalizePromptPostProcessing(value) {
        if (typeof value !== 'string') return 'strict';
        const normalized = value.trim();
        if (normalized === '') return '';
        return PROMPT_POST_PROCESSING_VALUES.includes(normalized) ? normalized : 'strict';
    }

    function normalizeJudgeApiPreset(raw) {
        const item = raw && typeof raw === 'object' ? raw : {};
        const name = String(item.name || '').trim();
        if (!name) return null;
        const numberOrDefault = (value, fallback) => {
            if (value === '' || value == null) return fallback;
            const num = Number(value);
            return Number.isFinite(num) ? num : fallback;
        };
        // v1（2.9）的 type 迁移：current→main、proxy→tavern、custom→custom。
        let connection = ['main', 'custom', 'tavern'].includes(item.connection) ? item.connection : '';
        if (!connection) {
            if (item.type === 'proxy') connection = 'tavern';
            else if (item.type === 'custom') connection = 'custom';
            else connection = 'main';
        }
        return {
            name,
            connection,
            customApiFormat: ['openai_compat', 'openai_responses', 'claude_messages', 'gemini_interactions'].includes(item.customApiFormat)
                ? item.customApiFormat
                : 'openai_compat',
            apiurl: connection === 'custom' ? String(item.apiurl || '').trim() : '',
            key: connection === 'custom' ? String(item.key || '') : '',
            model: connection === 'main' ? '' : String(item.model || '').trim(),
            // 缺省/非法值回退数据库（shujuku）同款默认：最大回复长度 60000、温度 1。
            maxTokens: Math.max(1, Math.floor(numberOrDefault(item.maxTokens, 60000))),
            temperature: numberOrDefault(item.temperature, 1),
            bodyParams: connection === 'custom' ? String(item.bodyParams || '') : '',
            excludeBodyParams: connection === 'custom' ? String(item.excludeBodyParams || '') : '',
            requestHeaders: connection === 'custom' ? String(item.requestHeaders || '') : '',
            promptPostProcessing: connection === 'custom' ? normalizePromptPostProcessing(item.promptPostProcessing) : '',
            tavernProfile: connection === 'tavern'
                ? String(item.tavernProfile || item.proxyPreset || '').trim()
                : '',
        };
    }

    function normalizeJudgeApiPresets(raw) {
        const out = [];
        const seen = new Set();
        (Array.isArray(raw) ? raw : []).forEach(item => {
            const preset = normalizeJudgeApiPreset(item);
            if (!preset || seen.has(preset.name)) return;
            seen.add(preset.name);
            out.push(preset);
        });
        return out;
    }

    function presetStorage() {
        for (const candidate of [hostWindow, currentWindow, ...windowCandidates]) {
            try {
                if (candidate && candidate.localStorage) return candidate.localStorage;
            } catch (error) {
                // 跨域窗口不能访问 localStorage，继续尝试同源候选。
            }
        }
        return null;
    }

    function readJudgeApiPresets() {
        const storage = presetStorage();
        if (!storage) return [];
        try {
            const raw = storage.getItem(JUDGE_PRESET_STORAGE_KEY);
            return normalizeJudgeApiPresets(raw ? JSON.parse(raw) : []);
        } catch (error) {
            reportOnce('judge-preset-read', `读取本地API 预设失败：${error.message || error}`);
            return [];
        }
    }

    function writeJudgeApiPresets(presets) {
        const storage = presetStorage();
        if (!storage) throw new Error('当前页面无法访问 localStorage，不能保存API 预设。');
        const normalized = normalizeJudgeApiPresets(presets);
        storage.setItem(JUDGE_PRESET_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function findJudgeApiPreset(name) {
        const wanted = String(name || '').trim();
        return readJudgeApiPresets().find(item => item.name === wanted) || null;
    }

    // 排除主体参数归一化（复刻 shujuku normalizeExcludeBodyParamsForSillyTavern_ACU）：
    // 逗号/换行分隔的键名列表转成 YAML 序列；已是 YAML（- 开头 / [ / {）则原样透传。
    function normalizeExcludeBodyParams(raw) {
        if (typeof raw !== 'string') return '';
        const trimmed = raw.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('- ') || trimmed.startsWith('[') || trimmed.startsWith('{')) return trimmed;
        return trimmed.split(/[,\n]/).map(item => item.trim()).filter(Boolean).map(key => `- ${key}`).join('\n');
    }

    // 原版酒馆原生协议源的 reverse_proxy 基址归一化（复刻 shujuku normalizeSTNativeProxyBase_ACU）：
    // - claude 源后端 fetch(基址 + '/messages')：基址须含 /v1；
    // - makersuite 源后端自补 /v1beta：基址不得带版本段。
    function normalizeNativeProxyBase(rawUrl, nativeSource) {
        let base = String(rawUrl || '').trim().replace(/\/+$/, '');
        if (!base) return '';
        for (const suffix of ['/chat/completions', '/messages', '/responses', '/interactions']) {
            if (base.endsWith(suffix)) { base = base.slice(0, -suffix.length).replace(/\/+$/, ''); break; }
        }
        if (nativeSource === 'claude') {
            if (base.endsWith('/v1beta')) base = base.slice(0, -'/v1beta'.length).replace(/\/+$/, '');
            if (!base.endsWith('/v1')) return `${base}/v1`;
            return base;
        }
        for (const suffix of ['/v1beta', '/v1']) {
            if (base.endsWith(suffix)) { base = base.slice(0, -suffix.length).replace(/\/+$/, ''); break; }
        }
        return base;
    }

    // 自定义连接的判断AI请求体（复刻 shujuku buildCustomApiRequestBody_ACU 的非流式形态）。
    // 接口协议映射原版酒馆：claude_messages→claude、gemini_interactions→makersuite（原生协议源），
    // openai_compat / openai_responses→custom（ST 无 Responses 后端，回退 /chat/completions）。
    function buildJudgeCustomRequestBody(messages, preset, streaming) {
        const sourceByFormat = {
            openai_compat: 'custom',
            openai_responses: 'custom',
            claude_messages: 'claude',
            gemini_interactions: 'makersuite',
        };
        const chatCompletionSource = sourceByFormat[preset.customApiFormat] || 'custom';
        const nativeSource = chatCompletionSource !== 'custom' ? chatCompletionSource : null;
        let headers = preset.key ? `Authorization: Bearer ${preset.key}` : '';
        const extraHeaders = String(preset.requestHeaders || '').trim();
        if (extraHeaders) headers = headers ? `${headers}\n${extraHeaders}` : extraHeaders;
        const body = {
            messages: (Array.isArray(messages) ? messages : []).map(message =>
                message && typeof message === 'object' && !Array.isArray(message) && typeof message.role === 'string'
                    ? { ...message, role: message.role.toLowerCase() }
                    : message),
            model: String(preset.model || '').replace(/^models\//, ''),
            max_tokens: preset.maxTokens != null ? preset.maxTokens : 60000,
            temperature: preset.temperature != null ? preset.temperature : 1,
            // 流式输出（v2.18，数据库 streamingEnabled 同款）：开启后酒馆后端返回 SSE。
            stream: Boolean(streaming),
            chat_completion_source: chatCompletionSource,
            group_names: [],
            include_reasoning: false,
            reasoning_effort: 'medium',
            enable_web_search: false,
            request_images: false,
            reverse_proxy: nativeSource ? normalizeNativeProxyBase(preset.apiurl, nativeSource) : preset.apiurl,
            // 原生协议源（claude/makersuite）从 reverse_proxy + proxy_password 取地址与密钥；
            // custom 源不用该字段，保持空串。
            proxy_password: nativeSource ? String(preset.key || '') : '',
            custom_url: preset.apiurl,
            custom_include_headers: headers,
            custom_include_body: String(preset.bodyParams || ''),
            custom_exclude_body: normalizeExcludeBodyParams(preset.excludeBodyParams),
        };
        // 「未选择」（''）时不携带该字段，酒馆后端按 none 处理、原样透传消息。
        if (preset.promptPostProcessing) body.custom_prompt_post_processing = preset.promptPostProcessing;
        return body;
    }

    // ---------------------------------------------------------------
    // 二、适配层：酒馆宿主接口（对齐 shujuku ai-gateway，全部走酒馆）
    //
    // 脚本不直接连第三方 API：拉模型走酒馆后端 /api/backends/chat-completions/status
    // （由酒馆服务器代发，行为和酒馆自己的「测试连接 / 拉模型」一致，也没有浏览器跨域问题）；
    // 「酒馆预设」连接的判断AI走酒馆连接管理器 ConnectionManagerRequestService。
    // ---------------------------------------------------------------

    // 主窗口的 window.SillyTavern 只有 { libs, getContext }，真正的接口都在 getContext() 里。
    function sillyTavernContext() {
        for (const candidate of [hostWindow, currentWindow, ...windowCandidates]) {
            try {
                const st = candidate && candidate.SillyTavern;
                const context = st && typeof st.getContext === 'function' ? st.getContext() : null;
                if (context && typeof context === 'object') return context;
            } catch (error) {
                // 跨域窗口读不了属性，继续尝试同源候选。
            }
        }
        return null;
    }

    // 酒馆请求头（含 CSRF token），拿不到的场合返回空对象，由后端报错提示。
    function hostRequestHeaders() {
        try {
            const context = sillyTavernContext();
            if (context && typeof context.getRequestHeaders === 'function') {
                const headers = context.getRequestHeaders();
                if (headers && typeof headers === 'object') return headers;
            }
        } catch (error) {
            // 忽略，按空请求头继续。
        }
        return {};
    }

    function hostFetch(...args) {
        const fetchFn = (typeof fetch === 'function' && fetch)
            || (hostWindow && hostWindow.fetch)
            || (currentWindow && currentWindow.fetch);
        if (!fetchFn) throw new Error('当前环境没有 fetch，无法通过酒馆后端请求。');
        return fetchFn(...args);
    }

    // 酒馆连接管理器（ConnectionManagerRequestService），「酒馆预设」连接的判断AI调用走这里。
    function connectionManagerService() {
        try {
            const context = sillyTavernContext();
            const service = context && context.ConnectionManagerRequestService;
            if (service && typeof service.sendRequest === 'function') return service;
        } catch (error) {
            // 同上：跨域候选不是运行接口来源。
        }
        return null;
    }

    // 酒馆连接预设列表（连接管理器里的 profiles），对应 API 页「酒馆预设」下拉。
    function readTavernConnectionProfiles() {
        try {
            const context = sillyTavernContext();
            const manager = context && context.extensionSettings && context.extensionSettings.connectionManager;
            const profiles = manager && manager.profiles;
            return (Array.isArray(profiles) ? profiles : [])
                .filter(profile => profile && profile.id)
                .map(profile => ({ id: String(profile.id), name: String(profile.name || profile.id) }));
        } catch (error) {
            return [];
        }
    }

    // 复刻 shujuku fetchAvailableModels_ACU：把拉模型请求发给酒馆后端
    // /api/backends/chat-completions/status，由酒馆服务器带着端点与密钥去请求目标 API。
    async function fetchAvailableModels(apiurl, key) {
        const url = String(apiurl || '').trim();
        if (!url) throw new Error('请输入端点(基础URL)。');
        const response = await hostFetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: { ...hostRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reverse_proxy: url,
                proxy_password: '',
                chat_completion_source: 'custom',
                custom_url: url,
                custom_include_headers: key ? `Authorization: Bearer ${key}` : '',
            }),
        });
        if (!response.ok) {
            const detail = await response.text();
            let message = `酒馆端点状态检查失败：${response.status} ${response.statusText || ''}`.trim();
            try {
                const parsed = JSON.parse(detail);
                message += `。详情：${parsed.error || parsed.message || detail}`;
            } catch (error) {
                if (detail) message += `。详情：${detail}`;
            }
            throw new Error(message);
        }
        const data = await response.json();
        const list = Array.isArray(data) ? data
            : (Array.isArray(data && data.models) ? data.models
                : (Array.isArray(data && data.data) ? data.data : []));
        return list.map(item => (typeof item === 'string' ? item : (item && item.id)))
            .filter(Boolean)
            .map(String);
    }

    // ---------------------------------------------------------------
    // 二、适配层：变量（角色变量存绑定列表，聊天变量按绑定分别存进度）
    //
    // 一条绑定 = 一个被关闭的大纲条目。可以同时有好几条绑定，
    // 每条绑定的镜像和进度都靠 bindingKey 区分开。
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

    // ≤2.4 的注入 id：带绑定指纹后缀。现在只在启动清理旧版注入残留时用到。
    function injectionIdFor(key) {
        return `${INJECTION_ID}-${hashText(key).slice(0, 6)}`;
    }

    // 2.0 的 config 是扁平的单个绑定；2.1 变成 { version: 2, bindings: […] }。
    function normalizeConfig(raw) {
        const empty = { version: 2, bindings: [], settings: {} };
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
        // settings 原样保留，逐个字段校验（目前只有 autoAdvance 三档）。
        const settings = raw.settings && typeof raw.settings === 'object' ? { ...raw.settings } : {};
        if (!['off', 'marker', 'judge'].includes(settings.autoAdvance)) settings.autoAdvance = 'off';
        // 判断AI的提问模板：空值回落到默认文案；引擎非法值归 auto。
        if (settings.judgePrompt != null && typeof settings.judgePrompt !== 'string') {
            settings.judgePrompt = String(settings.judgePrompt);
        }
        // 判断AI提示词段（v2.11.1）：必须是 [{role: system|user|assistant, content: string}]；
        // 非法项丢弃，整列非法时删字段回落默认段。旧 judgePrompt 单模板在组装时仍兼容。
        // v2.11.2 起取消「最终提示词注入」，清除该字段。
        delete settings.judgeFinalPrompt;
        if (settings.judgeSegments != null) {
            if (!Array.isArray(settings.judgeSegments)) {
                delete settings.judgeSegments;
            } else {
                const cleaned = settings.judgeSegments
                    .filter(seg => seg && typeof seg === 'object')
                    .map(seg => ({
                        role: ['system', 'user', 'assistant'].includes(seg.role) ? seg.role : 'user',
                        content: seg.content != null ? String(seg.content) : '',
                    }));
                if (cleaned.length) settings.judgeSegments = cleaned;
                else delete settings.judgeSegments;
            }
        }
        // 判断AI选用的本地 API 预设名；空字符串 = 使用酒馆当前 API。
        if (settings.judgePreset != null && typeof settings.judgePreset !== 'string') settings.judgePreset = String(settings.judgePreset);
        // 判断AI检查频率：每 N 层（条 AI 回复）检查一次，非法值回退 1（每层都查）。
        if (settings.judgeInterval != null) {
            const n = Math.floor(Number(settings.judgeInterval));
            settings.judgeInterval = Number.isFinite(n) && n >= 1 ? n : 1;
        }
        // 判断时参考最近几段角色回复（v2.15）：只看 AI 正文，非法值回退 1（只看最新一段）。
        if (settings.judgeHistoryCount != null) {
            const n = Math.floor(Number(settings.judgeHistoryCount));
            settings.judgeHistoryCount = Number.isFinite(n) && n >= 1 ? n : 1;
        }
        // 流式输出（v2.18，数据库 streamingEnabled 同款）：只认布尔，缺省 false。
        if (settings.streamingEnabled != null) settings.streamingEnabled = settings.streamingEnabled === true;
        // 判断AI输出的提取/排除规则（v2.13）：数据库填表同款 {start,end} 边界对；
        // 非法项丢弃，整列为空时删字段（= 不过滤，原文直通）。
        ['extractRules', 'excludeRules'].forEach(field => {
            if (settings[field] == null) return;
            const rules = RuleModule.normalize(settings[field]);
            if (rules.length) settings[field] = rules;
            else delete settings[field];
        });
        // v2.9 起判断AI统一由酒馆助手 generateRaw 调用；清除旧数据库相关配置。
        delete settings.judgeEngine;
        delete settings.judgeApiPresets;
        return { version: 2, bindings, settings };
    }

    function autoAdvanceMode(config) {
        const mode = config && config.settings ? config.settings.autoAdvance : 'off';
        return ['off', 'marker', 'judge'].includes(mode) ? mode : 'off';
    }

    const AUTO_ADVANCE_LABELS = {
        off: '手动推进（只有写了完成条件的阶段会自动进入下一段）',
        marker: '标记判断（AI 自己判断时机，不额外花请求）',
        judge: '判断AI（每条回复多花一次小请求，判断更准确）',
    };

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
    // 二、适配层：读取当前状态、镜像同步、推进、绑定
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
        if (config.bindings.length === 0) return { configured: false, config, contexts: [] };
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
                    autoAdvance: autoAdvanceMode(config),
                    stage: parsed.stages[state.stageIndex] || null,
                    addons: activeAddons(parsed, state.stageIndex),
                    entryEnabled: !entryIsDisabled(located.entry),
                    legacy: hasLegacyLayout(located.entry),
                });
            } catch (error) {
                contexts.push({ key, binding, configured: true, broken: true, error: error.message || String(error) });
            }
        }
        return { configured: true, config, contexts };
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
            || left.lastCompletionFingerprint !== right.lastCompletionFingerprint
            || left.lastJudgeCheckedId !== right.lastJudgeCheckedId;
    }

    // ---------------------------------------------------------------
    // 二、适配层：镜像条目（v2.5 起）
    //
    // 扩展提示词的锚点（预设之前 / 主提示词块 / 聊天深度）复刻不了世界书
    // 条目的位置——BEFORE_PROMPT 会排到预设开头之前，IN_PROMPT 会并进主
    // 提示词块，这就是 v2.4 注入出现在提示词最顶上的原因。所以现在不再
    // 注入提示词，而是在同一本世界书里维护一个「（动态指导）」镜像条目：
    // 克隆原条目的位置、顺序、关键词等全部设置，只把内容换成当前阶段。
    // 原条目保持关闭、原文不动；镜像就排在原条目原来的位置。
    // ---------------------------------------------------------------

    // 旧版（≤2.4）走 injectPrompts / setExtensionPrompt 注入；升级后第一次启动时清掉残留。
    let clearedLegacyInjections = false;

    async function clearLegacyInjections() {
        if (clearedLegacyInjections) return;
        clearedLegacyInjections = true;
        const uninjectPrompts = api('uninjectPrompts', false);
        const channel = extensionPromptChannel();
        let ids = [INJECTION_ID];
        try {
            const config = await readConfig();
            ids = ids.concat(config.bindings.map(binding => injectionIdFor(bindingKey(binding))));
        } catch (error) {
            // 配置读不出来也至少清掉无后缀的旧 id
        }
        if (uninjectPrompts) await Promise.resolve(uninjectPrompts(ids));
        if (channel) ids.forEach(id => channel.set(id, '', channel.types.NONE, 0));
    }

    // 诊断和界面里展示条目位置用的中文描述。
    function positionText(position) {
        const spot = position || {};
        switch (spot.type) {
            case 'before_character_definition': return '角色定义前';
            case 'after_character_definition': return '角色定义后';
            case 'before_example_messages': return '示例消息前';
            case 'after_example_messages': return '示例消息后';
            case 'at_depth': {
                const depth = Math.max(0, Number(spot.depth) || 0);
                const role = spot.role === 'user' ? '用户' : spot.role === 'assistant' ? 'AI' : '系统';
                return `聊天深度 ${depth} · ${role}`;
            }
            default: return spot.type ? String(spot.type) : '未设置（跟随世界书默认位置）';
        }
    }

    // 酒馆原生扩展提示接口：现在只用于清理 ≤2.4 留下的注入残留。
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

    // ---------------------------------------------------------------
    // 二、适配层：镜像条目的读写小工具
    // ---------------------------------------------------------------

    function mirrorNameFor(name) {
        return `${name}（动态指导）`;
    }

    // 返回可原地增删的条目数组；{entries:{...}} 对象形态时返回 null，增删走对象键。
    function worldbookEntryList(worldbook) {
        if (Array.isArray(worldbook)) return worldbook;
        if (worldbook && Array.isArray(worldbook.entries)) return worldbook.entries;
        return null;
    }

    function addEntryToWorldbook(worldbook, entry) {
        const list = worldbookEntryList(worldbook);
        if (list) {
            list.push(entry);
            return;
        }
        if (worldbook && worldbook.entries && typeof worldbook.entries === 'object') {
            worldbook.entries[String(entry.uid)] = entry;
        }
    }

    function removeEntryFromWorldbook(worldbook, target) {
        const list = worldbookEntryList(worldbook);
        if (list) {
            const at = list.indexOf(target);
            if (at >= 0) list.splice(at, 1);
            return;
        }
        if (worldbook && worldbook.entries && typeof worldbook.entries === 'object') {
            Object.keys(worldbook.entries).forEach(key => {
                if (worldbook.entries[key] === target) delete worldbook.entries[key];
            });
        }
    }

    function freshUid(worldbook) {
        const used = worldbookEntries(worldbook).map(entry => Number(entry.uid)).filter(Number.isFinite);
        return used.length > 0 ? Math.max(...used) + 1 : 1;
    }

    // 克隆原条目的全部设置（位置、顺序、关键词、概率、递归开关……），
    // 只覆盖镜像自己的身份：uid、名字、内容、开关。
    function buildMirrorEntry(original, uid, name, content) {
        const mirror = { ...original, uid, comment: name, name, title: name, content, enabled: true };
        if ('disable' in mirror) mirror.disable = false;
        return mirror;
    }

    function mirrorDiffers(mirror, want) {
        return Object.keys(want).some(key => key !== 'uid'
            && JSON.stringify(mirror[key]) !== JSON.stringify(want[key]));
    }

    // 找一条绑定名下的镜像（可能有历史遗留的多个同名，调用方只留第一个）。
    function findMirrorEntries(worldbook, context, mirrorName) {
        const originalUid = context.entry && context.entry.uid;
        return worldbookEntries(worldbook).filter(item =>
            !sameUid(item.uid, originalUid)
            && (sameUid(item.uid, context.binding && context.binding.mirrorUid) || entryName(item) === mirrorName));
    }

    // 原地同步：原条目保持关闭；镜像存在，且位置等字段、内容都与原条目和当前阶段对齐。
    // 调用方先在读到的副本上试跑，有变化才真的写世界书——避免每次生成都写一次世界书文件。
    function syncMirrorInPlace(worldbook, context, text) {
        const mirrorName = mirrorNameFor(entryName(context.entry));
        const original = findEntry(worldbook, context.entry.uid, entryName(context.entry));
        let changed = false;
        if (original && !entryIsDisabled(original)) {
            original.enabled = false;
            if ('disable' in original) original.disable = true;
            changed = true;
        }
        const mirrors = findMirrorEntries(worldbook, context, mirrorName);
        const mirror = mirrors[0] || null;
        mirrors.slice(1).forEach(extra => {
            removeEntryFromWorldbook(worldbook, extra);
            changed = true;
        });
        if (text == null) {
            if (mirror) {
                removeEntryFromWorldbook(worldbook, mirror);
                changed = true;
            }
            return { changed, mirrorName, mirrorUid: null, text };
        }
        if (!mirror) {
            const created = buildMirrorEntry(original || context.entry, freshUid(worldbook), mirrorName, text);
            addEntryToWorldbook(worldbook, created);
            return { changed: true, mirrorName, mirrorUid: created.uid, text };
        }
        const want = buildMirrorEntry(original || context.entry, mirror.uid, mirrorName, text);
        if (mirrorDiffers(mirror, want)) {
            Object.assign(mirror, want);
            changed = true;
        }
        return { changed, mirrorName, mirrorUid: mirror.uid, text };
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

    // 当前进度应该显示给 AI 的正文；没有可显示的内容（旧布局、没阶段）时返回 null。
    function guideTextFor(context, generationType) {
        if (!context || !context.configured) return null;
        if (context.legacy || context.parsed.stages.length === 0) return null;
        let index = context.state.stageIndex;
        // 刚靠完成标记推进过的那条消息如果被重新生成（swipe），仍按推进前的阶段显示
        if ((generationType === 'swipe' || generationType === 'regenerate')
            && index > 0
            && context.state.lastCompletionMessageId != null) {
            const lastId = currentMessageId();
            if (lastId != null && String(lastId) === String(context.state.lastCompletionMessageId)) index -= 1;
        }
        const stage = context.parsed.stages[index];
        if (!stage) return null;
        return formatInjection(stage, activeAddons(context.parsed, index),
            { auto: context.autoAdvance === 'marker' });
    }

    // 同步一条绑定的镜像。先在读到的副本上试跑，没变化就不写世界书；
    // 有变化才写，写后读回验证内容，防止世界书接口把字段吞掉。
    async function syncMirrorFor(context, generationType) {
        const text = guideTextFor(context, generationType);
        const preview = await getWorldbook(context.worldbookName);
        const plan = syncMirrorInPlace(preview, context, text);
        if (!plan.changed) return plan;
        await updateWorldbook(context.worldbookName, worldbook => {
            syncMirrorInPlace(worldbook, context, text);
            return worldbook;
        });
        const saved = findMirrorEntries(await getWorldbook(context.worldbookName), context, plan.mirrorName)[0] || null;
        if (text != null && (!saved || normalizeText(saved.content || '') !== normalizeText(text))) {
            throw new Error(`镜像条目“${plan.mirrorName}”写入后读回不一致，请稍后重试。`);
        }
        return plan;
    }

    // 绑定坏了（条目被删或改名）时，把可能残留的镜像清掉，避免旧阶段内容继续发给 AI。
    async function removeOrphanMirror(binding) {
        const mirrorName = mirrorNameFor(binding.entryName || '');
        const bound = await boundWorldbookNames(await currentCharacter()).catch(() => []);
        const candidates = Array.from(new Set([binding.worldbookName, ...bound].filter(Boolean)));
        for (const worldbookName of candidates) {
            try {
                const matches = entry => sameUid(entry.uid, binding.mirrorUid) || entryName(entry) === mirrorName;
                const orphans = worldbookEntries(await getWorldbook(worldbookName)).filter(matches);
                if (orphans.length === 0) continue;
                await updateWorldbook(worldbookName, worldbook => {
                    worldbookEntries(worldbook).slice().forEach(entry => {
                        if (matches(entry)) removeEntryFromWorldbook(worldbook, entry);
                    });
                    return worldbook;
                });
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] 清理世界书“${worldbookName}”里的镜像失败`, error);
            }
        }
    }

    // 每条绑定各自同步自己的镜像：内容 = 当前阶段（swipe/重新生成时用推进前的阶段）。
    async function syncMirrors(generationType) {
        const all = await loadContexts();
        let configChanged = false;
        for (const context of all.contexts) {
            if (context.broken) {
                reportOnce(`broken-${context.key}`, context.error);
                await removeOrphanMirror(context.binding);
                continue;
            }
            if (context.entryEnabled) {
                // 来源条目又被打开了：为了不让整份大纲直接发给 AI，同步时会重新关闭它。
                reportOnce(`re-disabled-${context.key}`, `“${entryName(context.entry)}”被重新打开过，已再次关闭，避免整份大纲直接发给 AI。`);
            }
            if (context.legacy) {
                reportOnce(`legacy-layout-${context.key}`, `“${entryName(context.entry)}”仍使用旧版划分。请先打开动态指导助手，点“转换成新版格式”；转换前不会显示指导。`);
            } else if (context.parsed.stages.length === 0) {
                reportOnce(`no-stages-${context.key}`, `“${entryName(context.entry)}”还没有分阶段，这次不会显示指导。`);
            } else if (statesDiffer(context.rawState, context.state)) {
                await writeStateFor(context.key, { ...context.state, updatedAt: new Date().toISOString() });
            }
            const plan = await syncMirrorFor(context, generationType);
            const before = context.binding.mirrorUid == null ? null : String(context.binding.mirrorUid);
            const after = plan.mirrorUid == null ? null : String(plan.mirrorUid);
            if (before !== after) {
                context.binding.mirrorUid = plan.mirrorUid == null ? undefined : plan.mirrorUid;
                configChanged = true;
            }
        }
        if (configChanged && all.config) await writeConfig(all.config);
        LogModule.debug('同步', `镜像同步完成（${generationType || 'normal'}），${all.contexts.length} 条绑定`);
        return all;
    }

    // 把链路逐项体检一遍：环境、接口、事件、绑定，以及每条绑定的镜像条目
    // 是否存在、内容是否与当前阶段一致。结果给面板上的「诊断」卡用，也挂在 publicApi 上。
    async function collectDiagnostics() {
        const rows = [];
        const push = (label, ok, detail) => rows.push({ label, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
        push('脚本实例', isCurrentInstance(), isCurrentInstance() ? `v${VERSION} 是当前实例` : '有另一个实例在运行，本实例已停用（可能重复启用了多个版本）');
        push('酒馆助手本体', Boolean(helper), helper ? '已找到' : '没有找到 TavernHelper，脚本只有解析功能');
        try {
            const getVersion = api('getTavernHelperVersion', false);
            if (getVersion) push('酒馆助手版本', true, String(await Promise.resolve(getVersion())));
        } catch (error) {
            push('酒馆助手版本', false, error.message || String(error));
        }
        ['getVariables', 'updateVariablesWith', 'getWorldbook', 'updateWorldbookWith', 'getWorldbookNames',
            'getCharWorldbookNames', 'getCharData', 'eventOn', 'getLastMessageId']
            .forEach(name => push(`接口 ${name}`, Boolean(api(name, false)), api(name, false) ? '可用' : '缺失'));
        const eventsTable = apiValue('tavern_events');
        push('事件表 tavern_events', Boolean(eventsTable), eventsTable ? '可用' : '缺失');
        if (eventsTable) {
            ['GENERATION_AFTER_COMMANDS', 'MESSAGE_RECEIVED', 'CHAT_CHANGED']
                .forEach(name => push(`事件 ${name}`, Boolean(eventsTable[name]), String(eventsTable[name] || '缺失')));
        }
        try {
            const config = await readConfig();
            push('绑定数量', config.bindings.length > 0, `${config.bindings.length} 条`);
            const mode = autoAdvanceMode(config);
            push('自动推进', true, AUTO_ADVANCE_LABELS[mode]);
            if (mode === 'judge') {
                push('接口 generateRaw', Boolean(api('generateRaw', false)),
                    api('generateRaw', false) ? '可用' : '缺失——判断AI用不了，请改用「标记判断」或升级酒馆助手');
                const localPresets = readJudgeApiPresets();
                const selectedPreset = config.settings && config.settings.judgePreset || '';
                push('本机API 预设', !selectedPreset || localPresets.some(item => item.name === selectedPreset),
                    selectedPreset ? `${selectedPreset}（本机共 ${localPresets.length} 个）` : `使用酒馆当前 API（本机共 ${localPresets.length} 个预设）`);
            }
            const stateMap = config.bindings.length > 0 ? await readState(config) : {};
            for (const binding of config.bindings) {
                const label = `绑定「${binding.entryName || binding.worldbookName}」`;
                try {
                    const located = await locateEntry(binding);
                    if (!located) {
                        push(label, false, '找不到条目（可能被删或改名）');
                        continue;
                    }
                    const parsed = parseOutline(located.entry.content || '');
                    push(label, parsed.stages.length > 0,
                        `${parsed.stages.length} 个阶段；条目${entryIsDisabled(located.entry) ? '已关闭' : '现在是打开的（同步时会自动关闭）'}；位置：${positionText(located.entry.position)}`);
                    // 镜像行：内容必须与当前进度应有的正文逐字一致
                    const mirrorName = mirrorNameFor(entryName(located.entry));
                    const state = reconcileState(stateMap[bindingKey(binding)] || null, parsed);
                    const stage = parsed.stages[state.stageIndex] || null;
                    const want = stage && !hasLegacyLayout(located.entry)
                        ? formatInjection(stage, activeAddons(parsed, state.stageIndex),
                            { auto: autoAdvanceMode(config) === 'marker' })
                        : null;
                    const mirror = findMirrorEntries(await getWorldbook(located.worldbookName),
                        { binding, entry: located.entry }, mirrorName)[0] || null;
                    if (want == null) {
                        push(`镜像「${mirrorName}」`, mirror == null,
                            mirror == null ? '当前没有可显示的内容，不需要镜像' : '有多余镜像，同步时会自动删掉');
                    } else if (!mirror) {
                        push(`镜像「${mirrorName}」`, false, '还没创建——下一次生成、或打开管理页时会自动创建');
                    } else {
                        const synced = normalizeText(mirror.content || '') === normalizeText(want);
                        push(`镜像「${mirrorName}」`, synced && !entryIsDisabled(mirror),
                            `${String(mirror.content || '').length} 字，${synced ? '与当前阶段一致' : '与当前阶段不一致（同步时会自动更新）'}；位置：${positionText(mirror.position)}`);
                    }
                } catch (error) {
                    push(label, false, error.message || String(error));
                }
            }
        } catch (error) {
            push('读取绑定列表', false, error.message || String(error));
        }
        return rows;
    }

    function diagnosticsText(rows) {
        const lines = [`动态指导助手 v${VERSION} 诊断报告`];
        rows.forEach(row => lines.push(`${row.ok ? '✅' : '❌'} ${row.label}${row.detail ? `：${row.detail}` : ''}`));
        return lines.join('\n');
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
            lastJudgeCheckedId: context.state.lastJudgeCheckedId == null ? null : context.state.lastJudgeCheckedId,
            updatedAt: new Date().toISOString(),
        };
        await writeStateFor(context.key, next);
        LogModule.info('推进', `「${entryName(context.entry)}」${context.state.stageIndex} → ${index}${next.stageName ? `：${next.stageName}` : '（全部阶段已完成）'}`);
        // 进度一变就把镜像内容换成新阶段，不用等下一次生成事件。
        await syncMirrors('normal');
        if (settings.notify !== false) {
            const label = entryName(context.entry);
            notify(next.stageName
                ? `「${label}」当前阶段：${next.stageName}`
                : `「${label}」全部阶段已完成，之后不再显示指导。`, 'success');
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
        await writeConfig({ version: 2, bindings, settings: config.settings || {} });
        await writeStateFor(key, {
            stageIndex: 0,
            stageName: parsed.stages[0].name,
            lastCompletionMessageId: null,
            lastCompletionFingerprint: '',
            lastJudgeCheckedId: null,
            updatedAt: new Date().toISOString(),
        });
        // 立刻按最新绑定列表同步镜像，不用等下一次事件。
        await syncMirrors('normal');
        LogModule.info('绑定', `已添加「${entryName(fresh)}」（${worldbookName}），共 ${parsed.stages.length} 个阶段`);
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
        // 先恢复条目、删掉镜像，再删绑定；即使中途失败也不会留下“条目关着却没人管”的状态。
        if (located) {
            const mirrorName = mirrorNameFor(entryName(located.entry));
            await updateWorldbook(located.worldbookName, worldbook => {
                const target = findEntry(worldbook, binding.entryUid, binding.entryName);
                if (target) {
                    target.enabled = true;
                    if ('disable' in target) target.disable = false;
                }
                worldbookEntries(worldbook).slice().forEach(item => {
                    if (sameUid(item.uid, located.entry.uid)) return;
                    if (sameUid(item.uid, binding.mirrorUid) || entryName(item) === mirrorName) {
                        removeEntryFromWorldbook(worldbook, item);
                    }
                });
                return worldbook;
            });
        } else {
            await removeOrphanMirror(binding);
        }
        await writeConfig({ version: 2, bindings: config.bindings.filter(item => bindingKey(item) !== key), settings: config.settings || {} });
        await writeStateFor(key, null);
        LogModule.info('绑定', `已移出「${binding.entryName || '条目'}」，条目已重新打开`);
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

    // 判断AI（judge 档）：每条 AI 回复后静默问一次当前阶段是否完成。
    // 提示词在二级页面按「段」自定义（每段可选 system/user/assistant 角色，
    // 支持 {{stage}}/{{prompt}}/{{condition}}/{{history}} 占位符，可导入导出/恢复默认）；
    // 调用通道按 API 预设的连接方式分流（全部走酒馆，对齐 shujuku）：
    //   酒馆主 API → 酒馆助手 generateRaw；酒馆预设 → ConnectionManagerRequestService；
    //   自定义 → 酒馆后端 /api/backends/chat-completions/generate（body 复刻 shujuku 构建）。
    // running 集合防止同一绑定并发判断AI；判断AI结果一律只信一次，失败不重试。
    const judgeState = { running: new Set() };

    // 最近一次判断AI调用的留痕（v2.14）：只存内存，给规则测试器「填入最近一次输出」用。
    const judgeRuntime = { lastRaw: '', lastFiltered: '', lastAt: 0, lastYes: null };

    // 判断AI提示词：抄数据库（shujuku）剧情推进页的「提示词段」结构，每段可选
    // system / user / assistant 角色。默认模板用数据库填表格式：标签化输出契约 +
    // assistant 预确认段 + 【】分区上下文（判断规则直接写在上下文段末尾），
    // 面向低智力模型——句子短、规则只有三条、结论写进 <结论> 标签，拿不准就 NO。
    const DEFAULT_JUDGE_SYSTEM_PROMPT = [
        '你是剧情进度判断AI，只负责判断当前剧情阶段有没有演完。',
        '输出格式（填表）：把判断写进下面两个标签，标签外不要写任何内容。',
        '<依据>最近剧情里实际演到的事，一两句话</依据>',
        '<结论>YES 或 NO</结论>',
    ].join('\n');

    const DEFAULT_JUDGE_SEGMENTS = [
        { role: 'system', content: DEFAULT_JUDGE_SYSTEM_PROMPT },
        { role: 'assistant', content: '收到。我只根据给定的剧情填表：完成条件里的事真实演过，<结论> 才写 YES；没演到、只演了一半、或者我不确定，都写 NO。' },
        {
            role: 'user',
            content: [
                '【当前阶段】',
                '{{stage}}',
                '',
                '【本阶段要演的内容】',
                '{{prompt}}',
                '',
                '【完成条件】',
                '{{condition}}',
                '',
                '【最近演到哪了】',
                '{{history}}',
                '',
                '判断规则：',
                '1. 只看「最近演到哪了」，不要脑补里面没写的事。',
                '2. 完成条件里写的事，在剧情里真实演过了，才算完成。',
                '3. 没演到、只演了一半、或者你不确定，都算没完成。',
                '现在填表：当前阶段演完了吗？',
            ].join('\n'),
        },
    ];

    const JUDGE_SEGMENT_ROLES = ['system', 'user', 'assistant'];

    function fillJudgePlaceholders(template, stage, condition, history) {
        return String(template || '')
            .replace(/\{\{\s*stage\s*\}\}/g, stage.name)
            .replace(/\{\{\s*prompt\s*\}\}/g, stage.prompt)
            .replace(/\{\{\s*condition\s*\}\}/g, condition)
            .replace(/\{\{\s*history\s*\}\}/g, history);
    }

    // 兼容旧版：settings.judgePrompt 单模板字符串仍然生效（相当于 system 段 + 单个 user 段）；
    // 一旦保存过 judgeSegments 就改用段列表。judgeSegments 为空/未设时用默认段。
    function judgeMessageSpecs(settings) {
        const legacy = settings && typeof settings.judgePrompt === 'string' ? settings.judgePrompt.trim() : '';
        if (legacy && !Array.isArray(settings.judgeSegments)) {
            return [{ role: 'system', content: DEFAULT_JUDGE_SYSTEM_PROMPT }, { role: 'user', content: settings.judgePrompt }];
        }
        return Array.isArray(settings && settings.judgeSegments) && settings.judgeSegments.length
            ? settings.judgeSegments : DEFAULT_JUDGE_SEGMENTS;
    }

    // 组装判断AI消息：逐段替换占位符；空内容段丢弃。
    function judgeMessagesFor(settings, stage, condition, history) {
        const messages = judgeMessageSpecs(settings)
            .filter(seg => seg && JUDGE_SEGMENT_ROLES.includes(seg.role) && typeof seg.content === 'string' && seg.content.trim())
            .map(seg => ({ role: seg.role, content: fillJudgePlaceholders(seg.content, stage, condition, history) }));
        if (!messages.length) {
            messages.push({ role: 'user', content: fillJudgePlaceholders('当前阶段「{{stage}}」演完了吗？演完了回答 YES，没演完回答 NO。', stage, condition, history) });
        }
        return messages;
    }

    // 判定结论：优先读 <结论> 标签（填表格式）；没有标签时回退「开头就是 YES」的旧规则。
    function judgeSaysYes(text) {
        const raw = String(text || '');
        const tag = raw.match(/<结论>\s*([\s\S]*?)<\/结论>/i);
        if (tag) return /^\s*YES\b/i.test(tag[1]);
        return /^\s*YES\b/i.test(raw);
    }

    // 边界规则应用（v2.13 输出侧 / v2.14 起对齐数据库：同时作用于发送前的最近剧情）。
    // 先按提取规则截取、再按排除规则删除（与数据库顺序一致）；规则为空 = 原文直通。
    function applyBoundaryRules(text, settings) {
        const source = settings && typeof settings === 'object' ? settings : {};
        return RuleModule.apply(text, {
            extractRules: source.extractRules,
            excludeRules: source.excludeRules,
        });
    }
    // 兼容别名：v2.13 公开的名字。
    const applyJudgeOutputRules = applyBoundaryRules;

    // 规则测试器用的预览（v2.14）：给定任意样例文本和一组规则（可以是未保存的草稿），
    // 返回过滤结果 + 解析结论，UI 直接展示，不用真跑剧情就能调规则。
    function previewJudgeOutput(text, settings) {
        const raw = String(text == null ? '' : text);
        const filtered = applyBoundaryRules(raw, settings);
        return {
            filtered,
            changed: filtered !== raw,
            yes: judgeSaysYes(filtered),
            hasTag: /<结论>[\s\S]*?<\/结论>/i.test(filtered),
        };
    }

    // 判断AI检查频率（数据库填表同款「每 N 层」频率制）：每 N 条 AI 回复检查一次；
    // 缺省/非法值回退 1 = 每层都查。
    function judgeCheckInterval(settings) {
        const n = Math.floor(Number(settings && settings.judgeInterval));
        return Number.isFinite(n) && n >= 1 ? n : 1;
    }

    // 判断时参考的最近剧情段数（v2.15）：只看 AI 发的正文，默认 1 = 只判断最新一条角色回复；
    // 选 2 以上会带上更早的角色回复（用户消息永远不发送）。缺省/非法值回退 1。
    function judgeHistoryCount(settings) {
        const n = Math.floor(Number(settings && settings.judgeHistoryCount));
        return Number.isFinite(n) && n >= 1 ? n : 1;
    }

    // 最近剧情（v2.15 语义）：只取 AI 发的正文——用户消息、系统消息一律不发给判断AI。
    // count = 参考最近几段角色回复（默认 1 = 只判断最新一段）；窗口按 count 放大，
    // 防止用户连发时凑不够段数。提取/排除规则在发送前逐段作用于角色消息（数据库同款），
    // 过滤后为空的消息整条丢弃。
    async function recentHistoryText(messageId, count, settings) {
        const getChatMessages = api('getChatMessages', false);
        if (!getChatMessages || messageId == null) return '';
        const want = Math.max(1, Math.floor(Number(count)) || 1);
        const windowSize = Math.min(Math.max(want * 4, 10), 100);
        const start = Math.max(0, Number(messageId) - windowSize + 1);
        const messages = await Promise.resolve(getChatMessages(`${start}-${messageId}`, { include_swipes: false }));
        if (!Array.isArray(messages)) return '';
        return messages
            .filter(item => item && item.role === 'assistant' && typeof item.message === 'string')
            .slice(-want)
            .map(item => {
                let text = String(item.message || '').replace(COMPLETE_MARKER_RE, '').trim();
                if (text && settings) text = applyBoundaryRules(text, settings).trim();
                return text ? `角色：${text}` : '';
            })
            .filter(Boolean)
            .join('\n\n');
    }

    // 「酒馆预设」连接：走酒馆连接管理器（对齐 shujuku sendConnectionManagerRequest_ACU），
    // 不再走 generateRaw 的 proxy_preset。messages 为完整段列表（含最终注入）。
    async function askJudgeViaConnectionProfile(messages, preset) {
        const service = connectionManagerService();
        if (!service) {
            throw new Error('酒馆连接管理器不可用（找不到 ConnectionManagerRequestService）：请升级酒馆版本，或把这个 API 预设改成「酒馆主 API / 自定义」连接。');
        }
        const maxTokens = preset.maxTokens != null ? preset.maxTokens : 60000;
        const result = await service.sendRequest(preset.tavernProfile, messages, maxTokens);
        // 对齐 shujuku：优先 result.result.choices[0].message.content，再退 result.content / 字符串。
        if (result && result.result && Array.isArray(result.result.choices)
            && result.result.choices[0] && result.result.choices[0].message
            && typeof result.result.choices[0].message.content === 'string') {
            return result.result.choices[0].message.content;
        }
        if (result && typeof result.content === 'string') return result.content;
        if (typeof result === 'string') return result;
        return '';
    }

    // 「自定义」连接：直连酒馆后端 /api/backends/chat-completions/generate
    // （复刻 shujuku 的自定义 API 调用，附加主体/排除参数/请求标头/提示词后处理全部生效）。
    // messages 为完整段列表（含最终注入）。
    // 从 OpenAI 形态 JSON 里取正文（自定义通道非流式/流式归一化都走这里）。
    function judgeTextFromJson(data) {
        const choice = data && Array.isArray(data.choices) && data.choices[0];
        return String((choice && choice.message && choice.message.content)
            || (choice && choice.text)
            || (data && data.content)
            || (data && data.text)
            || '');
    }

    // 流式响应（SSE）聚合（v2.18）：OpenAI 形态 choices[0].delta.content 与
    // Claude 原生 content_block_delta 都认（对齐数据库「流式 Claude 为原样 Anthropic SSE」），
    // [DONE] 结束，半包/注释行忽略。返回拼接出的完整文本。
    function parseJudgeSseText(raw) {
        let text = '';
        String(raw || '').split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try {
                const chunk = JSON.parse(payload);
                const choice = chunk && Array.isArray(chunk.choices) && chunk.choices[0];
                if (choice && choice.delta && typeof choice.delta.content === 'string') text += choice.delta.content;
                else if (choice && typeof choice.text === 'string') text += choice.text;
                else if (chunk && chunk.type === 'content_block_delta' && chunk.delta && typeof chunk.delta.text === 'string') text += chunk.delta.text;
            } catch (error) {
                // 非 JSON 的 data 行（心跳、注释）跳过。
            }
        });
        return text;
    }

    async function askJudgeViaCustomApi(messages, preset, streaming) {
        const response = await hostFetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...hostRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(buildJudgeCustomRequestBody(messages, preset, streaming)),
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`自定义 API 请求失败：${response.status} ${response.statusText || ''}${detail ? `。详情：${detail}` : ''}`.trim());
        }
        // 流式：后端可能返回 SSE，也可能归一化成 JSON——两种都认。
        if (streaming) {
            const raw = await response.text();
            try {
                const text = judgeTextFromJson(JSON.parse(raw));
                if (text) return text;
            } catch (error) {
                // 不是 JSON，按 SSE 聚合。
            }
            const text = parseJudgeSseText(raw);
            if (!text) throw new Error('自定义 API 返回无效响应（流式但没有正文）。');
            return text;
        }
        const data = await response.json();
        const text = judgeTextFromJson(data);
        if (!text) throw new Error('自定义 API 返回无效响应（没有正文）。');
        return text;
    }

    async function askJudge(messages, preset, settings) {
        const streaming = Boolean(settings && settings.streamingEnabled);
        if (preset && preset.connection === 'tavern') {
            if (!preset.tavernProfile) {
                throw new Error(`API 预设「${preset.name}」没有选择酒馆预设。`);
            }
            return askJudgeViaConnectionProfile(messages, preset);
        }
        if (preset && preset.connection === 'custom') {
            if (!preset.apiurl || !preset.model) {
                throw new Error(`API 预设「${preset.name}」缺少端点(基础URL)或模型名。`);
            }
            return askJudgeViaCustomApi(messages, preset, streaming);
        }
        // 酒馆主 API（或无预设）：走酒馆助手 generateRaw。
        // 段列表映射为 ordered_prompts 条目，最后一条 user 消息作为 user_input（最终注入）。
        // 最近剧情已通过 {{history}} 占位符写进段内容，不再叠加 chat_history，避免弱模型被重复内容干扰。
        const generateRaw = api('generateRaw', false);
        if (!generateRaw) return null;
        const lastUserIndex = messages.map((item, index) => (item.role === 'user' ? index : -1)).filter(index => index >= 0).pop();
        const userInput = lastUserIndex != null ? messages[lastUserIndex].content : '';
        const ordered = messages.filter((item, index) => index !== lastUserIndex)
            .map(item => ({ role: item.role, content: item.content }));
        ordered.push('user_input');
        const request = {
            user_input: userInput,
            should_silence: true,
            should_stream: streaming,
            max_chat_history: 0,
            ordered_prompts: ordered,
        };
        const result = await generateRaw(request);
        return typeof result === 'string'
            ? result
            : (result && typeof result === 'object' ? String(result.text || result.content || '') : '');
    }

    async function maybeJudgeAdvance(context, messageId, config) {
        if (!context || context.broken || !context.stage) return;
        // 同一条消息每条绑定最多推进一次：标记流程先到就轮到判断AI跳过。
        if (context.state.lastCompletionMessageId === messageId) return;
        if (judgeState.running.has(context.key)) return;
        const settings = config && config.settings ? config.settings : {};
        // 检查频率：每 N 层（条 AI 回复）查一次，数据库填表同款频率制；首次检查立即执行。
        const interval = judgeCheckInterval(settings);
        if (interval > 1 && context.state.lastJudgeCheckedId != null
            && Number(messageId) - Number(context.state.lastJudgeCheckedId) < interval) {
            LogModule.debug('判断AI', `「${entryName(context.entry)}」第 ${messageId} 层未到检查间隔（每 ${interval} 层），跳过`);
            return;
        }
        const presetName = typeof settings.judgePreset === 'string' ? settings.judgePreset.trim() : '';
        const preset = presetName ? findJudgeApiPreset(presetName) : null;
        if (presetName && !preset) {
            reportOnce(`judge-preset-missing:${presetName}`, `找不到本机 API 预设「${presetName}」，本次不推进；请重新选择或保存同名预设。`);
            return;
        }
        if (preset && preset.connection === 'tavern') {
            if (!connectionManagerService()) {
                reportOnce('judge-no-cm', '「酒馆预设」连接需要酒馆的连接管理器（ConnectionManagerRequestService），当前不可用；请升级酒馆版本或改用其他连接方式。');
                return;
            }
        } else if ((!preset || preset.connection === 'main') && !api('generateRaw', false)) {
            // 自定义连接直连酒馆后端，不需要 generateRaw。
            reportOnce('judge-no-engine', '「判断AI」需要酒馆助手的 generateRaw 接口，当前不可用；请改用「标记判断」档或升级酒馆助手。');
            return;
        }
        judgeState.running.add(context.key);
        const startStageIndex = context.state.stageIndex;
        const bindingLabel = entryName(context.entry);
        try {
            const stage = context.stage;
            const condition = stage.completion
                ? stage.completion
                : '没有写完成条件：本阶段要演的内容都演完、剧情自然该往下走了，就算完成。';
            // 只看 AI 最新正文（v2.15）：用户消息不发送；参考段数可在设置里调。
            const history = await recentHistoryText(messageId, judgeHistoryCount(settings), settings);
            const messages = judgeMessagesFor(settings, stage, condition, history || '（没有取到聊天记录）');
            LogModule.info('判断AI', `「${bindingLabel}」第 ${messageId} 层：开始检查阶段「${stage.name}」（${preset ? `API 预设「${preset.name}」` : '酒馆主 API'}）`);
            const startedAt = Date.now();
            const text = await askJudge(messages, preset, settings);
            // 本次检查已发生：记录检查楼层，「每 N 层」从这里重新计数（无论结论是 YES 还是 NO）。
            await writeStateFor(context.key, { ...context.state, lastJudgeCheckedId: messageId });
            // 先过提取/排除规则（数据库填表同款），削掉思维链等噪声后再解析结论。
            const filtered = applyBoundaryRules(text, settings);
            const yes = judgeSaysYes(filtered);
            // 留痕最近一次调用（只存内存）：规则测试器可以一键填入这份原始输出。
            judgeRuntime.lastRaw = String(text || '');
            judgeRuntime.lastFiltered = filtered;
            judgeRuntime.lastAt = Date.now();
            judgeRuntime.lastYes = yes;
            LogModule.debug('判断AI', `原始输出（${judgeRuntime.lastRaw.length} 字）：${judgeRuntime.lastRaw.slice(0, 500)}`);
            if (filtered !== judgeRuntime.lastRaw) {
                LogModule.debug('判断AI', `输出过滤生效：${judgeRuntime.lastRaw.length} → ${filtered.length} 字`);
            }
            LogModule.info('判断AI', `「${bindingLabel}」阶段「${stage.name}」结论：${yes ? 'YES（演完了）' : 'NO（继续）'}，耗时 ${Date.now() - startedAt} ms`);
            if (!yes) return;
            // 防误判守卫：判断AI是异步的，期间标记流程或用户操作可能已推进、又收到了新回复，
            // 这些情况下这次 YES 已经过期，必须放弃推进。
            const fresh = await loadContexts();
            const latest = fresh.contexts.find(item => item.key === context.key);
            if (!latest || latest.broken || !latest.stage) return;
            const nowMessageId = currentMessageId();
            if (latest.state.stageIndex !== startStageIndex
                || (nowMessageId != null && nowMessageId !== messageId)
                || latest.state.lastCompletionMessageId === messageId) {
                LogModule.warn('判断AI', `「${bindingLabel}」结论是 YES，但检查期间进度已变化，放弃本次过期推进`);
                return;
            }
            await moveToIndex(latest, latest.state.stageIndex + 1, { messageId });
        } catch (error) {
            const reason = error && error.message ? error.message : String(error);
            LogModule.error('判断AI', `「${bindingLabel}」调用失败：${reason}`);
            reportOnce('judge-failed', `判断AI调用失败：${reason}。请检查当前 API 连接，或把「自动推进」改用「标记判断」档。`);
        } finally {
            judgeState.running.delete(context.key);
        }
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
        LogModule.debug('事件', `收到正文（第 ${messageId} 层）`);

        const markers = Array.from(message.message.matchAll(COMPLETE_MARKER_RE));
        // judge 档即使没有完成标记也要走判断AI，所以不能在这里提前 return。
        if (markers.length === 0 && autoAdvanceMode(await readConfig()) !== 'judge') return;
        const all = await loadContexts();
        if (!all.configured) return;

        if (markers.length > 0) {
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

        // 判断AI档：标记流程之后按最新进度逐条绑定问判断AI（标记已推进的会被守卫跳过）。
        if (all.configured && autoAdvanceMode(all.config) === 'judge') {
            const fresh = await loadContexts();
            for (const context of fresh.contexts) {
                if (context.broken || !context.stage) continue;
                await maybeJudgeAdvance(context, messageId, fresh.config);
            }
        }
    }

    // ---------------------------------------------------------------
    // 三、界面：状态与小工具
    // ---------------------------------------------------------------

    const ui = {
        view: 'manager',
        renderedView: '',
        navOpen: false,
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
        diagnosis: null,
        // API 页草稿态（对齐 shujuku ApiConfigPanel 的 draft/snapshot/formMode）
        apiFormMode: 'empty',
        apiDraft: null,
        apiDraftOriginalName: '',
        apiDraftSnapshot: '',
        apiModelOptions: [],
        apiModelStatus: 'idle',
        apiModelError: '',
        apiTavernProfiles: [],
        // 判断AI提示词二级页草稿态（draft/snapshot 脏检查，对齐 shujuku 提示词抽屉）
        judgePromptDraft: null,
        judgePromptDraftSnapshot: '',
        // 提示词页「提取/排除规则」分组的展开态（默认折叠，对齐 AcuRulePairList）
        judgePromptRulesOpen: { extract: false, exclude: false },
        // 规则测试器（v2.14）：样例文本与最近一次试跑结果
        judgeRuleTestText: '',
        judgeRuleTestResult: null,
        // 运行日志页：等级 + 标签筛选
        logLevelFilter: 'all',
        logTagFilter: 'all',
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

    function field(label, control, hint) {
        return el('label', { class: 'dga-field' },
            el('span', { text: label }),
            control,
            hint ? el('small', { class: 'dga-field-hint', text: hint }) : null);
    }

    // 开关行（v2.18，复刻数据库 DashboardToggleRow）：标题 + 右侧开关 + 下方常驻描述。
    function toggleRow(label, description, checked, onchange) {
        const input = el('input', { type: 'checkbox', class: 'dga-switch', role: 'switch', 'aria-label': label });
        input.checked = Boolean(checked);
        input.disabled = ui.busy;
        input.addEventListener('change', event => onchange(event.target.checked));
        return el('div', { class: 'dga-toggle-row' },
            el('div', { class: 'dga-toggle-head' },
                el('span', { class: 'dga-toggle-label', text: label }),
                input),
            description ? el('p', { class: 'dga-toggle-desc', text: description }) : null);
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
            el('button', {
                type: 'button',
                class: 'dga-btn dga-ghost dga-nav-toggle',
                'aria-label': '打开目录',
                onclick: () => { ui.navOpen = true; render(); },
            }, '☰'),
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
        shell.replaceChildren(...(ui.view === 'editor' ? renderEditor() : (ui.view === 'api' ? renderApiPage() : (ui.view === 'judgePrompt' ? renderJudgePromptPage() : (ui.view === 'logs' ? renderLogPage() : (ui.view === 'guide' ? renderGuidePage() : renderManager()))))));
        shell.classList.toggle('dga-busy', ui.busy);
        const body = shell.querySelector('.dga-body');
        if (body) body.scrollTop = scrollTop;
        ui.renderedView = ui.view;
        if (ui.navOpen) shell.appendChild(renderNavDrawer());
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
        const body = el('div', { class: 'dga-body' },
            messageBar(),
            ui.contextError ? messageBar({ type: 'error', text: ui.contextError }) : null,
            statusCard(),
            settingsCard(),
        );
        return [header(SCRIPT_NAME, `v${VERSION} · ${ui.characterName}`, closePanel), body];
    }

    // 动态指导页（v2.19 起独立成页，不再堆在仪表盘）：每条绑定一张卡片，
    // 下面是添加指导条目与诊断；没有绑定时显示三步上手。
    function renderGuidePage() {
        const snapshot = ui.snapshot;
        const contexts = snapshot ? snapshot.contexts : [];
        const body = el('div', { class: 'dga-body' },
            messageBar(),
            ui.contextError ? messageBar({ type: 'error', text: ui.contextError }) : null,
            ...contexts.map(boundCard),
            contexts.length === 0 ? guideCard() : null,
            judgeSettingsCard(),
            addCard(),
            diagnosticsCard(),
        );
        return [header('动态指导', '指导条目与进度', () => { ui.view = 'manager'; render(); }, '返回'), body];
    }

    // 目录抽屉：复刻 shujuku 新版 Sidebar——品牌区（方块标 + 标题 + 版本副标）、
    // 组标题、整宽导航项（当前页用主题强调色高亮）。点击进入对应页面后自动收起。
    function renderNavDrawer() {
        const go = view => {
            if (view === 'editor' && !ui.editor) return;
            if (view === 'api') enterApiPage();
            ui.view = view;
            ui.navOpen = false;
            render();
        };
        const item = (label, view, disabled) => el('button', {
            type: 'button',
            class: `dga-nav-item${ui.view === view ? ' is-on' : ''}`,
            'aria-current': ui.view === view ? 'page' : null,
            disabled: Boolean(disabled),
            onclick: () => go(view),
        }, label);
        const backdrop = el('div', {
            class: 'dga-nav-backdrop',
            onclick: event => {
                if (event.target === backdrop) { ui.navOpen = false; render(); }
            },
        });
        backdrop.append(el('aside', { class: 'dga-nav-drawer', role: 'dialog', 'aria-label': '页面导航' },
            el('div', { class: 'dga-nav-brand' },
                el('span', { class: 'dga-nav-brand-mark', 'aria-hidden': 'true' }, '指'),
                el('span', { class: 'dga-nav-brand-copy' },
                    el('span', { class: 'dga-nav-brand-title' }, SCRIPT_NAME),
                    el('span', { class: 'dga-nav-brand-tag' }, `v${VERSION} · 页面导航`),
                ),
            ),
            el('div', { class: 'dga-nav-group-title' }, '页面'),
            el('div', { class: 'dga-nav-group' },
                item('仪表盘', 'manager'),
                item('动态指导', 'guide'),
                item('API', 'api'),
                item('运行日志', 'logs'),
            ),
        ));
        return backdrop;
    }

    // ---------------------------------------------------------------
    // 三、界面：独立 API 页（复刻 shujuku 新版 ApiConfigPanel）
    //
    // 结构对齐：预设选择行（下拉 + 新建 + 删除）→ 草稿表单（预设名称 /
    // 连接方式三段开关 / 各连接方式的字段区）→ 加载模型 inline 行 →
    // 最大回复长度+温度两列 → 放弃修改 / 保存按钮（脏检查）。
    // 草稿（draft）+ 快照（snapshot）比对决定按钮可用态，输入过程不重渲染。
    // ---------------------------------------------------------------

    function emptyApiDraft() {
        return {
            name: '', connection: 'main', customApiFormat: 'openai_compat',
            // 默认值与数据库（shujuku）一致：最大回复长度 60000、温度 1，不留空。
            apiurl: '', key: '', model: '', maxTokens: 60000, temperature: 1,
            bodyParams: '', excludeBodyParams: '', requestHeaders: '',
            promptPostProcessing: 'strict', tavernProfile: '',
        };
    }

    function currentJudgePreset() {
        const config = ui.snapshot ? ui.snapshot.config : null;
        const settings = config && config.settings ? config.settings : {};
        const name = String(settings.judgePreset || '');
        return { name, preset: readJudgeApiPresets().find(item => item.name === name) || null };
    }

    function syncApiDraft() {
        const { preset } = currentJudgePreset();
        if (preset) {
            ui.apiDraft = { ...emptyApiDraft(), ...preset };
            ui.apiDraftOriginalName = preset.name;
            ui.apiFormMode = 'edit';
        } else {
            ui.apiDraft = emptyApiDraft();
            ui.apiDraftOriginalName = '';
            ui.apiFormMode = 'empty';
        }
        ui.apiDraftSnapshot = JSON.stringify(ui.apiDraft);
        ui.apiModelStatus = 'idle';
        ui.apiModelError = '';
        ui.apiModelOptions = [];
    }

    // 进入 API 页：同步草稿 + 读酒馆连接预设列表（对齐 refreshAll）。
    function enterApiPage() {
        ui.apiTavernProfiles = readTavernConnectionProfiles();
        syncApiDraft();
    }

    function renderApiPage() {
        if (!ui.apiDraft) enterApiPage();
        const list = readJudgeApiPresets();
        const { name: currentName, preset: current } = currentJudgePreset();
        const draft = ui.apiDraft;
        const dirty = JSON.stringify(draft) !== ui.apiDraftSnapshot;

        // ── 预设选择行：下拉 + 新建 + 删除（对齐 AcuPresetDropdown 行）
        const presetOptions = [{ value: '', label: '酒馆主 API（不使用 API 预设）' }]
            .concat(list.map(item => ({ value: item.name, label: item.name })));
        const presetSelect = selectControl(presetOptions, currentName, value => runAction('切换 API 预设', async () => {
            const fresh = await readConfig();
            fresh.settings = { ...(fresh.settings || {}), judgePreset: value };
            await writeConfig(fresh);
            syncApiDraft();
        }, { success: value ? `API 预设已切换为：${value}` : '已改用酒馆主 API' }));
        const newBtn = el('button', {
            type: 'button', class: 'dga-icon-btn', title: '新建预设', 'aria-label': '新建预设',
            onclick: () => {
                ui.apiDraft = emptyApiDraft();
                ui.apiDraftOriginalName = '';
                ui.apiFormMode = 'create';
                ui.apiDraftSnapshot = JSON.stringify(ui.apiDraft);
                ui.apiModelStatus = 'idle';
                ui.apiModelError = '';
                ui.apiModelOptions = [];
                render();
            },
        }, '＋');
        const deleteBtn = el('button', {
            type: 'button', class: 'dga-icon-btn dga-icon-danger', title: '删除当前预设', 'aria-label': '删除当前预设',
            disabled: !current,
            onclick: () => {
                if (!current) return;
                if (!hostWindow.confirm(`删除 API 预设「${current.name}」？`)) return;
                runAction('删除 API 预设', async () => {
                    writeJudgeApiPresets(readJudgeApiPresets().filter(item => item.name !== current.name));
                    const fresh = await readConfig();
                    if (fresh.settings && fresh.settings.judgePreset === current.name) {
                        fresh.settings = { ...fresh.settings, judgePreset: '' };
                        await writeConfig(fresh);
                    }
                    syncApiDraft();
                }, { success: `API 预设「${current.name}」已删除` });
            },
        }, '✕');

        // ── 草稿表单
        const bindText = key => event => { draft[key] = event.target.value; };
        const bindAndRender = key => event => { draft[key] = event.target.value; render(); };

        const nameInput = el('input', { class: 'dga-input', type: 'text', maxlength: 60, autocomplete: 'off', oninput: bindText('name') });
        nameInput.value = draft.name;

        const connectionOptions = [
            { value: 'main', label: '酒馆主 API' },
            { value: 'custom', label: '自定义' },
            { value: 'tavern', label: '酒馆预设' },
        ];
        const connectionSeg = el('div', { class: 'dga-seg dga-mode-seg', role: 'group', 'aria-label': '连接方式' },
            connectionOptions.map(option => el('button', {
                type: 'button',
                class: `dga-seg-btn${draft.connection === option.value ? ' is-on' : ''}`,
                'aria-pressed': draft.connection === option.value,
                onclick: () => { draft.connection = option.value; render(); },
            }, option.label)));

        const formatOptions = [
            { value: 'openai_compat', label: '兼容 OpenAI' },
            { value: 'openai_responses', label: '兼容 OpenAI Responses' },
            { value: 'claude_messages', label: '兼容 Claude Messages' },
            { value: 'gemini_interactions', label: '兼容 Gemini Interactions' },
        ];
        const formatSelect = selectControl(formatOptions, draft.customApiFormat, value => { draft.customApiFormat = value; });

        const apiurlInput = el('input', { class: 'dga-input', type: 'text', maxlength: 500, placeholder: 'https://example.com/v1', autocomplete: 'off', oninput: bindText('apiurl') });
        apiurlInput.value = draft.apiurl;
        const keyInput = el('input', { class: 'dga-input', type: 'password', maxlength: 500, autocomplete: 'off', oninput: bindText('key') });
        keyInput.value = draft.key;
        const modelInput = el('input', { class: 'dga-input', type: 'text', maxlength: 160, autocomplete: 'off', oninput: bindText('model') });
        modelInput.value = draft.model;

        // 加载模型：始终可点，直接用当前表单里的端点与密钥（不需要先保存），
        // 请求走酒馆后端 /api/backends/chat-completions/status（与 shujuku 一致）。
        const loadModelsBtn = btn('加载模型', () => {
            ui.apiModelStatus = 'loading';
            ui.apiModelError = '';
            render();
            runAction('加载模型', async () => {
                try {
                    const names = await fetchAvailableModels(draft.apiurl, draft.key);
                    ui.apiModelOptions = names;
                    if (names.length === 0) {
                        ui.apiModelStatus = 'error';
                        ui.apiModelError = '未能解析模型数据或列表为空，可手填模型名。';
                        LogModule.warn('API', `拉取模型返回空列表（${draft.apiurl}）`);
                        setMessage('没有拉到模型，可以手填模型名。', 'warning');
                        return false;
                    }
                    ui.apiModelStatus = 'success';
                    LogModule.info('API', `拉取模型成功：${names.length} 个（${draft.apiurl}）`);
                    setMessage(`拉到 ${names.length} 个模型。`, 'success');
                } catch (error) {
                    ui.apiModelStatus = 'error';
                    ui.apiModelError = error.message || String(error);
                    LogModule.error('API', `拉取模型失败（${draft.apiurl}）：${error.message || error}`);
                    throw error;
                }
            }, { refresh: false });
        });
        const modelStatus = ui.apiModelStatus === 'loading' ? el('span', { class: 'dga-muted' }, '加载中...')
            : ui.apiModelStatus === 'error' ? el('span', { class: 'dga-danger-text' }, ui.apiModelError)
                : ui.apiModelStatus === 'success' ? el('span', { class: 'dga-muted' }, `已加载 ${ui.apiModelOptions.length} 个模型`)
                    : null;
        const modelListSelect = selectControl(
            ui.apiModelOptions.map(name => ({ value: name, label: name })),
            draft.model,
            value => { draft.model = value; render(); },
        );

        // 酒馆预设下拉：选项来自酒馆连接管理器的 profiles；草稿里存的是 profile id。
        const profileIds = ui.apiTavernProfiles.map(profile => profile.id);
        const tavernOptions = [{ value: '', label: '请选择' }]
            .concat(ui.apiTavernProfiles.map(profile => ({ value: profile.id, label: profile.name })));
        if (draft.tavernProfile && !profileIds.includes(draft.tavernProfile)) {
            tavernOptions.push({ value: draft.tavernProfile, label: `${draft.tavernProfile}（不在当前酒馆预设列表）` });
        }
        const tavernSelect = selectControl(tavernOptions, draft.tavernProfile, value => { draft.tavernProfile = value; render(); });
        const refreshProfilesBtn = btn('刷新列表', () => {
            ui.apiTavernProfiles = readTavernConnectionProfiles();
            render();
        }, { ghost: true });

        const maxTokensInput = el('input', { class: 'dga-input', type: 'number', min: 1, step: 1, oninput: bindText('maxTokens') });
        maxTokensInput.value = draft.maxTokens != null ? String(draft.maxTokens) : '';
        const temperatureInput = el('input', { class: 'dga-input', type: 'number', min: 0, max: 2, step: 0.05, oninput: bindText('temperature') });
        temperatureInput.value = draft.temperature != null ? String(draft.temperature) : '';

        // ── 保存 / 放弃（脏检查对齐 shujuku：与快照不一致才可点）
        const saveDraft = () => runAction('保存 API 预设', async () => {
            const preset = normalizeJudgeApiPreset(draft);
            if (!preset) throw new Error('预设名称不能为空。');
            if (preset.connection === 'tavern' && !preset.tavernProfile) throw new Error('请选择酒馆预设。');
            if (preset.connection === 'custom') {
                if (!preset.apiurl) throw new Error('自定义 API 需要填写端点(基础URL)。');
                if (!preset.model) throw new Error('自定义 API 需要填写模型。');
            }
            const remaining = readJudgeApiPresets()
                .filter(item => item.name !== ui.apiDraftOriginalName && item.name !== preset.name);
            writeJudgeApiPresets(remaining.concat([preset]));
            // 保存后自动设为当前（对齐 shujuku：保存即绑定到当前聊天）
            const fresh = await readConfig();
            fresh.settings = { ...(fresh.settings || {}), judgePreset: preset.name };
            await writeConfig(fresh);
            ui.apiDraftOriginalName = preset.name;
            syncApiDraft();
        }, { success: 'API 预设已保存并设为当前' });

        const formChildren = [
            field('预设名称', nameInput),
            field('连接方式', connectionSeg),
        ];
        if (draft.connection === 'custom') {
            const bodyParamsArea = el('textarea', { class: 'dga-input', rows: 3, placeholder: 'response_format:\n  type: json_object\ntop_k: 50', oninput: bindText('bodyParams') });
            bodyParamsArea.value = draft.bodyParams;
            const excludeBodyArea = el('textarea', { class: 'dga-input', rows: 2, placeholder: 'top_p, reasoning_effort', oninput: bindText('excludeBodyParams') });
            excludeBodyArea.value = draft.excludeBodyParams;
            const postProcessingOptions = [
                { value: '', label: '未选择' },
                { value: 'merge_tools', label: '合并相同角色连续的发言（含工具）' },
                { value: 'semi_tools', label: '半严格（强制对话角色交替）（含工具）' },
                { value: 'strict_tools', label: '严格（强制对话角色交替、用户最先）（含工具）' },
                { value: 'merge', label: '合并相同角色连续的发言' },
                { value: 'semi', label: '半严格（强制对话角色交替）' },
                { value: 'strict', label: '严格（强制对话角色交替、用户最先）' },
                { value: 'single', label: '单一用户消息（无工具）' },
            ];
            const postProcessingSelect = selectControl(postProcessingOptions, draft.promptPostProcessing, value => { draft.promptPostProcessing = value; });
            const requestHeadersArea = el('textarea', { class: 'dga-input', rows: 2, placeholder: 'X-Custom-Header: value', oninput: bindText('requestHeaders') });
            requestHeadersArea.value = draft.requestHeaders;
            formChildren.push(
                field('接口协议', formatSelect, '决定上游端点与请求/响应变形，默认兼容 OpenAI。原版酒馆把 Claude/Gemini 映射到服务端原生协议源（端点填协议根即可，自动补 /v1 或剥版本段），OpenAI Responses 回退兼容 OpenAI；纯原生端点下「加载模型」可能失败，可手填模型名。'),
                field('端点(基础URL)', apiurlInput),
                field('API 密钥', keyInput),
                field('模型名', modelInput),
                el('div', { class: 'dga-inline-action' }, loadModelsBtn, modelStatus),
                ui.apiModelOptions.length > 0
                    ? field('模型列表', el('div', { class: 'dga-model-pick' },
                        el('div', { class: 'dga-model-pick-arrow', text: '⬇ 模型拉到了，点下面的下拉框选一个' }),
                        modelListSelect,
                    ), '选中后会自动填进上面的「模型名」，填完也可以再手改。')
                    : null,
                el('div', { class: 'dga-two-col' },
                    field('最大回复长度', maxTokensInput),
                    field('温度', temperatureInput)),
                field('附加主体参数', bodyParamsArea, 'SillyTavern custom_include_body，填写 YAML object，会合并到最终模型请求体。'),
                field('排除主体参数', excludeBodyArea, '会转换为 SillyTavern custom_exclude_body，从最终模型请求体删除指定字段。'),
                field('提示词后处理', postProcessingSelect, '默认严格（与旧版本行为一致）。未选择=不带该字段原样透传消息，可保留提示词组中 system 段的角色。'),
                field('附加请求标头', requestHeadersArea, '每行一个 Header: Value，追加到请求头中。'),
            );
        } else if (draft.connection === 'tavern') {
            formChildren.push(
                field('酒馆预设', tavernSelect, '选项来自酒馆的连接管理器（Connection Manager） profiles。'),
                el('div', { class: 'dga-inline-action' }, refreshProfilesBtn),
                el('div', { class: 'dga-two-col' },
                    field('最大回复长度', maxTokensInput),
                    field('温度', temperatureInput)),
            );
        }

        return [
            header('API', 'API 预设管理', () => { ui.view = 'manager'; render(); }, '返回'),
            el('div', { class: 'dga-body' },
                messageBar(),
                muted('完整预设只保存在当前浏览器 localStorage（本机明文），不依赖数据库插件、不随角色卡导出；共享设备请勿保存敏感密钥。'),
                card('当前 API 预设',
                    list.length === 0 ? el('div', { class: 'dga-msg', 'data-type': 'warning' }, '暂无可用 API 预设，点右侧「＋」新建。') : null,
                    el('div', { class: 'dga-api-select-row' }, presetSelect, newBtn, deleteBtn),
                ),
                ui.apiFormMode !== 'empty' ? card(ui.apiFormMode === 'create' ? '新建预设' : `预设配置 · ${ui.apiDraftOriginalName}`,
                    ...formChildren,
                    el('div', { class: 'dga-api-actions' },
                        btn('放弃修改', () => { syncApiDraft(); render(); }, { ghost: true, disabled: !dirty }),
                        btn(ui.apiFormMode === 'create' ? '保存并选中预设' : '保存当前预设', saveDraft, { primary: true, disabled: !dirty }),
                    ),
                ) : null,
            ),
        ];
    }

    // 判断AI提示词二级页（从管理页设置卡「判断AI提示词…」进入）：仿数据库剧情推进页的
    // 提示词段编辑 + 提示词抽屉的草稿/保存语义——编辑只改草稿，点「保存」才写入设置；
    // 支持一键导入/导出 JSON、放弃修改与恢复默认。旧版 judgePrompt 单模板仍生效，
    // 在本页保存一次即自动转成段结构。
    function syncJudgePromptDraft() {
        const config = ui.snapshot ? ui.snapshot.config : null;
        const settings = config && config.settings ? config.settings : {};
        const segments = judgeMessageSpecs(settings).map(seg => ({ role: seg.role, content: seg.content }));
        ui.judgePromptDraft = {
            segments,
            extractRules: RuleModule.normalize(settings.extractRules),
            excludeRules: RuleModule.normalize(settings.excludeRules),
        };
        ui.judgePromptDraftSnapshot = JSON.stringify(ui.judgePromptDraft);
    }

    function renderJudgePromptPage() {
        if (!ui.judgePromptDraft) syncJudgePromptDraft();
        const config = ui.snapshot ? ui.snapshot.config : null;
        const settings = config && config.settings ? config.settings : {};
        const useLegacy = Boolean(typeof settings.judgePrompt === 'string' && settings.judgePrompt.trim())
            && !Array.isArray(settings.judgeSegments);
        const draft = ui.judgePromptDraft;
        const segments = draft.segments;
        const dirty = JSON.stringify(draft) !== ui.judgePromptDraftSnapshot;
        const roleOptions = JUDGE_SEGMENT_ROLES.map(role => ({ value: role, label: role.toUpperCase() }));
        const touch = () => render();
        const patchAt = (index, patch) => { segments[index] = { ...segments[index], ...patch }; };
        const moveAt = (index, delta) => {
            const target = index + delta;
            if (target < 0 || target >= segments.length) return;
            const [item] = segments.splice(index, 1);
            segments.splice(target, 0, item);
            touch();
        };
        const insertAt = position => {
            const seg = { role: 'user', content: '' };
            if (position === 'top') segments.unshift(seg); else segments.push(seg);
            touch();
        };
        const iconBtn = (label, title, onclick, options) => el('button', {
            type: 'button',
            class: `dga-icon-btn${options && options.danger ? ' dga-icon-danger' : ''}`,
            title, 'aria-label': title,
            disabled: Boolean(ui.busy || (options && options.disabled)),
            onclick,
        }, label);
        const items = segments.map((seg, index) => el('div', { class: 'dga-pseg' },
            el('div', { class: 'dga-pseg-head' },
                el('span', { class: 'dga-pseg-index', text: `#${index + 1}` }),
                selectControl(roleOptions, seg.role, value => { patchAt(index, { role: value }); touch(); }),
                el('div', { class: 'dga-pseg-actions' },
                    iconBtn('↑', index === 0 ? '已经是第一段' : '上移该段', () => moveAt(index, -1), { disabled: index === 0 }),
                    iconBtn('↓', index === segments.length - 1 ? '已经是最后一段' : '下移该段', () => moveAt(index, 1), { disabled: index === segments.length - 1 }),
                    iconBtn('✕', '删除该段', () => { segments.splice(index, 1); touch(); }, { danger: true }))),
            el('textarea', {
                class: 'dga-input', rows: 4, placeholder: '提示词内容…支持 {{stage}} {{prompt}} {{condition}} {{history}} 占位符',
                text: seg.content,
                onchange: event => { patchAt(index, { content: event.target.value }); touch(); },
            })));

        // 提取/排除规则分组：复刻数据库 AcuRulePairList——默认折叠、头部带条数，
        // 每行「开始边界 → 结束边界 + 删除」，底部添加按钮。编辑进同一草稿，随「保存」生效。
        const ruleGroup = (groupKey, fieldName, label, startPlaceholder, endPlaceholder, addLabel) => {
            const openState = ui.judgePromptRulesOpen || (ui.judgePromptRulesOpen = { extract: false, exclude: false });
            const open = Boolean(openState[groupKey]);
            const rules = Array.isArray(draft[fieldName]) ? draft[fieldName] : (draft[fieldName] = []);
            const setRules = next => { draft[fieldName] = next; render(); };
            const patchRule = (index, patch) => setRules(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));
            const rows = rules.map((rule, index) => el('div', { class: 'dga-rule-row' },
                el('input', {
                    class: 'dga-input', type: 'text', placeholder: startPlaceholder, value: rule.start,
                    onchange: event => patchRule(index, { start: event.target.value }),
                }),
                el('span', { class: 'dga-rule-sep', text: '→' }),
                el('input', {
                    class: 'dga-input', type: 'text', placeholder: endPlaceholder, value: rule.end,
                    onchange: event => patchRule(index, { end: event.target.value }),
                }),
                iconBtn('✕', '删除此规则', () => setRules(rules.filter((rule, position) => position !== index)), { danger: true })));
            return el('div', { class: 'dga-rule-group' },
                el('button', {
                    type: 'button', class: 'dga-rule-head', 'aria-expanded': open ? 'true' : 'false',
                    onclick: () => { openState[groupKey] = !open; render(); },
                },
                    el('span', { class: `dga-rule-chevron${open ? ' is-open' : ''}`, text: '▸' }),
                    el('span', { class: 'dga-rule-label', text: label }),
                    el('span', { class: 'dga-rule-count', text: rules.length ? `${rules.length} 条` : '暂无' })),
                open ? el('div', { class: 'dga-rule-body' },
                    ...rows,
                    rules.length === 0 ? el('div', { class: 'dga-rule-empty', text: '暂无规则，点击下方按钮添加。' }) : null,
                    el('div', { class: 'dga-rule-add' }, btn(`＋ ${addLabel}`, () => setRules([...rules, { start: '', end: '' }]), { ghost: true }))) : null);
        };

        const saveDraft = () => runAction('保存判断AI提示词', async () => {
            const fresh = await readConfig();
            fresh.settings = { ...(fresh.settings || {}) };
            fresh.settings.judgeSegments = draft.segments
                .filter(seg => seg && JUDGE_SEGMENT_ROLES.includes(seg.role))
                .map(seg => ({ role: seg.role, content: String(seg.content || '') }));
            fresh.settings.judgePrompt = '';
            delete fresh.settings.judgeFinalPrompt;
            const extractRules = RuleModule.normalize(draft.extractRules);
            const excludeRules = RuleModule.normalize(draft.excludeRules);
            if (extractRules.length) fresh.settings.extractRules = extractRules;
            else delete fresh.settings.extractRules;
            if (excludeRules.length) fresh.settings.excludeRules = excludeRules;
            else delete fresh.settings.excludeRules;
            await writeConfig(fresh);
            ui.judgePromptDraftSnapshot = JSON.stringify(ui.judgePromptDraft);
            return true;
        }, { success: '判断AI提示词已保存' });

        const importInput = el('input', {
            type: 'file', accept: '.json,application/json', style: 'display:none',
            onchange: async event => {
                const input = event.target;
                const file = input.files && input.files[0];
                input.value = '';
                if (!file) return;
                try {
                    const parsed = JSON.parse(await file.text());
                    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.segments);
                    if (!Array.isArray(list)) throw new Error('文件里没有提示词段列表（segments）。');
                    const cleaned = list
                        .filter(seg => seg && typeof seg === 'object')
                        .map(seg => ({
                            role: JUDGE_SEGMENT_ROLES.includes(seg.role) ? seg.role : 'user',
                            content: seg.content != null ? String(seg.content) : '',
                        }));
                    if (!cleaned.length) throw new Error('文件里没有可用的提示词段。');
                    draft.segments = cleaned;
                    // 兼容旧导出文件：没有规则字段时保留当前草稿里的规则。
                    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
                        if (parsed.extractRules != null) draft.extractRules = RuleModule.normalize(parsed.extractRules);
                        if (parsed.excludeRules != null) draft.excludeRules = RuleModule.normalize(parsed.excludeRules);
                    }
                    const ruleCount = draft.extractRules.length + draft.excludeRules.length;
                    setMessage(`已导入 ${cleaned.length} 个提示词段${ruleCount ? `、${ruleCount} 条输出规则` : ''}；点「保存」后生效。`, 'success');
                    render();
                } catch (error) {
                    setMessage(`导入判断AI提示词失败：${error.message || error}`, 'error');
                    render();
                }
            },
        });
        const exportBtn = btn('导出', () => {
            const win = hostWindow();
            const payload = {
                type: 'dynamic-guide-judge-prompt', version: 1,
                segments: draft.segments,
                extractRules: RuleModule.normalize(draft.extractRules),
                excludeRules: RuleModule.normalize(draft.excludeRules),
            };
            const blob = new win.Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = win.URL.createObjectURL(blob);
            const link = el('a', { href: url, download: '动态指导助手-判断AI提示词.json' });
            hostDocument().body.appendChild(link);
            link.click();
            link.remove();
            win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
            setMessage('已导出当前草稿的提示词段。', 'success');
        }, { ghost: true });

        const back = () => { ui.view = 'guide'; ui.judgePromptDraft = null; render(); };
        return [
            header('判断AI提示词', '判断AI · 提示词段与输出规则', back, '返回'),
            el('div', { class: 'dga-body' },
                messageBar(),
                muted('每段选一个角色按顺序发送；占位符：{{stage}} {{prompt}} {{condition}} {{history}}。结论优先读 <结论> 标签，没标签时看开头是不是 YES。'),
                useLegacy ? el('div', { class: 'dga-msg', 'data-type': 'info' }, '正在使用旧版自定义提问（按 system + 单个 user 段生效）。在本页点「保存」会自动转成提示词段，旧模板内容已放进 user 段。') : null,
                card('提示词段',
                    el('div', { class: 'dga-pseg-add' }, btn('＋ 在最上方插入', () => insertAt('top'), { ghost: true })),
                    ...items,
                    segments.length === 0 ? muted('暂无提示词段。用上方按钮添加，或点「恢复默认提示词」。') : null,
                    el('div', { class: 'dga-pseg-add' }, btn('＋ 在最下方插入', () => insertAt('bottom'), { ghost: true })),
                ),
                card('提取 / 排除规则（上下文过滤）',
                    muted('发送前过滤角色回复，解析结论前也会再过滤一次判断AI输出。提取 = 只留「开始~结束」之间（取最后命中）；排除 = 删掉该区间。留空 = 不过滤。例：排除 <think>→</think> 可削思维链。'),
                    ruleGroup('extract', 'extractRules', '提取规则', '提取开始边界', '提取结束边界', '添加提取规则'),
                    ruleGroup('exclude', 'excludeRules', '排除规则', '排除开始边界', '排除结束边界', '添加排除规则'),
                ),
                card('规则测试',
                    (() => {
                        // 规则测试器（v2.14）：用当前草稿里的规则试跑一段样例输出，
                        // 直接看过滤结果和解析出的结论；可一键填入最近一次判断AI的真实输出。
                        const result = ui.judgeRuleTestResult;
                        return el('div', { class: 'dga-rule-tester' },
                            el('div', { class: 'dga-rule-tester-title', text: '用当前草稿试跑，不保存也生效' }),
                            el('textarea', {
                                class: 'dga-input', rows: 3,
                                placeholder: '把一段角色回复（或判断AI输出）粘到这里…',
                                text: ui.judgeRuleTestText || '',
                                onchange: event => { ui.judgeRuleTestText = event.target.value; },
                            }),
                            el('div', { class: 'dga-rule-tester-actions' },
                                btn('填入最近一次判断AI输出', () => {
                                    ui.judgeRuleTestText = judgeRuntime.lastRaw;
                                    render();
                                }, { ghost: true, disabled: !judgeRuntime.lastRaw }),
                                btn('测试', () => {
                                    ui.judgeRuleTestResult = previewJudgeOutput(ui.judgeRuleTestText, {
                                        extractRules: draft.extractRules,
                                        excludeRules: draft.excludeRules,
                                    });
                                    render();
                                }, { ghost: true, disabled: !(ui.judgeRuleTestText || '').trim() }),
                            ),
                            result ? el('div', { class: 'dga-rule-tester-result' },
                                el('div', { class: 'dga-rule-tester-verdict' },
                                    el('span', {
                                        class: `dga-verdict ${result.yes ? 'is-yes' : 'is-no'}`,
                                        text: result.yes ? '结论：YES（会推进）' : '结论：NO（不推进）',
                                    }),
                                    el('span', { class: 'dga-muted', text: `${result.hasTag ? '命中 <结论> 标签' : '没有 <结论> 标签，按开头判断'}${result.changed ? ' · 规则改变了输出' : ' · 输出未被规则改变'}` }),
                                ),
                                el('pre', { class: 'dga-rule-tester-filtered', text: result.filtered.length > 2000 ? `${result.filtered.slice(0, 2000)}\n…（共 ${result.filtered.length} 字，已截断）` : result.filtered }),
                            ) : null);
                    })(),
                ),
                el('div', { class: 'dga-api-actions' },
                    btn('导入', () => importInput.click(), { ghost: true }),
                    exportBtn,
                    btn('恢复默认提示词', () => {
                        draft.segments = DEFAULT_JUDGE_SEGMENTS.map(seg => ({ ...seg }));
                        setMessage('已载入内置默认提示词；点「保存」后生效。', 'info');
                        render();
                    }, { ghost: true }),
                    btn('放弃修改', () => { syncJudgePromptDraft(); render(); }, { ghost: true, disabled: !dirty }),
                    btn('保存', saveDraft, { primary: true, disabled: !dirty }),
                ),
                importInput,
            ),
        ];
    }

    // ---------------------------------------------------------------
    // 三、界面：运行日志页（二级页，从目录抽屉进入）
    //
    // 展示 LogModule 的内存日志：等级筛选 + 调试日志采集开关 + 复制/清空。
    // 页面打开期间订阅日志模块，新日志实时刷新；日志只存内存（上限 500 条），
    // 不写变量、不上传。
    // ---------------------------------------------------------------

    const LOG_LEVEL_LABELS = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
    let logPageSubscribed = false;

    function renderLogPage() {
        if (!logPageSubscribed) {
            logPageSubscribed = true;
            LogModule.subscribe(() => {
                if (ui.view === 'logs' && !ui.busy) render();
            });
        }
        const all = LogModule.list();
        const filter = ui.logLevelFilter || 'all';
        const tagFilter = ui.logTagFilter || 'all';
        const filtered = all.filter(entry => (filter === 'all' || entry.level === filter)
            && (tagFilter === 'all' || entry.tag === tagFilter));
        // 等级统计行（v2.14）
        const counts = { debug: 0, info: 0, warn: 0, error: 0 };
        all.forEach(entry => { counts[entry.level] = (counts[entry.level] || 0) + 1; });
        const statsText = `共 ${all.length} 条 · 信息 ${counts.info} · 警告 ${counts.warn} · 错误 ${counts.error}${counts.debug ? ` · 调试 ${counts.debug}` : ''}`;
        const formatTime = timestamp => {
            const date = new Date(timestamp);
            const pad = value => String(value).padStart(2, '0');
            return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        };
        const formatLine = entry => `${formatTime(entry.time)} [${LOG_LEVEL_LABELS[entry.level] || entry.level}] [${entry.tag}] ${entry.message}`;
        const rows = filtered.slice().reverse().map(entry => el('div', { class: `dga-log-row dga-log-${entry.level}` },
            el('span', { class: 'dga-log-time', text: formatTime(entry.time) }),
            el('span', { class: `dga-log-level dga-log-level-${entry.level}`, text: LOG_LEVEL_LABELS[entry.level] || entry.level }),
            el('span', { class: 'dga-log-tag', text: `[${entry.tag}]` }),
            el('span', { class: 'dga-log-text', text: entry.message })));
        const back = () => { ui.view = 'manager'; render(); };
        return [
            header('运行日志', `${statsText} · 上限 500 · 只存内存`, back, '返回'),
            el('div', { class: 'dga-body' },
                messageBar(),
                el('div', { class: 'dga-log-toolbar' },
                    selectControl([
                        { value: 'all', label: '全部等级' },
                        { value: 'info', label: '信息' },
                        { value: 'warn', label: '警告' },
                        { value: 'error', label: '错误' },
                        { value: 'debug', label: '调试' },
                    ], filter, value => { ui.logLevelFilter = value; render(); }),
                    selectControl(
                        [{ value: 'all', label: '全部标签' }].concat(LogModule.tags().map(tag => ({ value: tag, label: tag }))),
                        tagFilter,
                        value => { ui.logTagFilter = value; render(); },
                    ),
                    el('label', { class: 'dga-log-debug-toggle' },
                        el('input', {
                            type: 'checkbox', checked: LogModule.isDebugEnabled(),
                            onchange: event => { LogModule.setDebugEnabled(event.target.checked); render(); },
                        }),
                        '采集调试日志'),
                    btn('复制', () => {
                        copyText(filtered.map(formatLine).join('\n'));
                    }, { ghost: true, disabled: filtered.length === 0 }),
                    btn('导出', () => {
                        const win = hostWindow();
                        const blob = new win.Blob([filtered.map(formatLine).join('\n')], { type: 'text/plain;charset=utf-8' });
                        const url = win.URL.createObjectURL(blob);
                        const stamp = new Date();
                        const pad = value => String(value).padStart(2, '0');
                        const link = el('a', {
                            href: url,
                            download: `动态指导助手-运行日志-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.txt`,
                        });
                        hostDocument().body.appendChild(link);
                        link.click();
                        link.remove();
                        win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
                        setMessage(`已导出 ${filtered.length} 条日志。`, 'success');
                    }, { ghost: true, disabled: filtered.length === 0 }),
                    btn('清空', () => { LogModule.clear(); render(); }, { ghost: true, disabled: all.length === 0 }),
                ),
                rows.length
                    ? el('div', { class: 'dga-log-list' }, ...rows)
                    : muted('暂无日志。判断AI检查、阶段推进、绑定变更、拉取模型等都会记在这里；关掉面板日志不清空，刷新页面才清空。'),
            ),
        ];
    }

    // 仪表盘顶部「运行概览」卡（v2.18，复刻数据库 DashboardPage 健康项版式）：
    // 每行 = 图标圆块 + 标题/摘要 + 右侧徽章（可带跳转按钮）。
    // 三行：API（当前预设状态）、当前显示（第一条绑定走到哪段）、运行日志（报错统计）。
    function statusCard() {
        const snapshot = ui.snapshot;
        const contexts = snapshot ? snapshot.contexts : [];
        const { name: presetName, preset } = currentJudgePreset();
        const first = contexts[0];

        const healthItem = ({ kind, icon, title, summary, badge, badgeKind, actionLabel, onAction }) =>
            el('article', { class: `dga-health-item is-${kind}` },
                el('div', { class: 'dga-health-icon', 'aria-hidden': 'true', text: icon }),
                el('div', { class: 'dga-health-body' },
                    el('strong', { text: title }),
                    el('p', { text: summary })),
                el('div', { class: 'dga-health-side' },
                    el('span', { class: `dga-badge is-${badgeKind}`, text: badge }),
                    actionLabel ? el('button', {
                        type: 'button', class: 'dga-health-action', onclick: onAction,
                    }, `${actionLabel} →`) : null));

        // ── API：预设缺失/字段不全 = 需要处理；否则已配置。
        let apiItem;
        if (presetName && !preset) {
            apiItem = { kind: 'error', icon: '×', title: 'API', summary: `选中的 API 预设「${presetName}」已不存在，判断AI将改用酒馆主 API。`, badge: '需要处理', badgeKind: 'error' };
        } else if (preset && preset.connection === 'custom' && (!preset.apiurl || !preset.model)) {
            apiItem = { kind: 'error', icon: '×', title: 'API', summary: `API 预设「${presetName}」缺少端点或模型名，还不能发起请求。`, badge: '未配置', badgeKind: 'error' };
        } else if (preset && preset.connection === 'tavern' && !preset.tavernProfile) {
            apiItem = { kind: 'error', icon: '×', title: 'API', summary: `API 预设「${presetName}」未选择酒馆连接预设。`, badge: '未配置', badgeKind: 'error' };
        } else {
            apiItem = { kind: 'ok', icon: '✓', title: 'API', summary: `目前 API 是：${presetName || '酒馆主 API'}。`, badge: '已配置', badgeKind: 'ok' };
        }
        apiItem.actionLabel = '配置 API';
        apiItem.onAction = () => { enterApiPage(); ui.view = 'api'; ui.navOpen = false; render(); };

        // ── 当前显示：第一条绑定走到哪段。
        let stageItem;
        if (!first) {
            stageItem = { kind: 'idle', icon: '–', title: '当前显示', summary: '还没有添加指导条目。', badge: '未添加', badgeKind: 'idle' };
        } else if (first.broken) {
            stageItem = { kind: 'error', icon: '×', title: '当前显示', summary: String(first.error || '绑定异常。'), badge: '需要处理', badgeKind: 'error' };
        } else {
            const total = first.parsed.stages.length;
            const index = first.state.stageIndex;
            const done = total > 0 && index >= total;
            stageItem = {
                kind: 'ok', icon: '✓', title: '当前显示',
                summary: (done ? '全部阶段已完成。' : `第 ${index + 1} 段 · ${first.stage ? first.stage.name : '—'}。`)
                    + (contexts.length > 1 ? ` 共 ${contexts.length} 条绑定。` : ''),
                badge: done ? '已完成' : '正常', badgeKind: 'ok',
            };
        }

        // ── 运行日志：报错统计，有错误优先显示。
        const counts = { warn: 0, error: 0 };
        LogModule.list().forEach(entry => { if (counts[entry.level] != null) counts[entry.level] += 1; });
        const logItem = counts.error
            ? { kind: 'error', icon: '×', title: '运行日志', summary: `本次会话累计 ${counts.error} 条错误、${counts.warn} 条警告，点右侧查看详情。`, badge: `${counts.error} 条报错`, badgeKind: 'error' }
            : counts.warn
                ? { kind: 'warning', icon: '!', title: '运行日志', summary: `没有错误；有 ${counts.warn} 条警告，一般不影响使用。`, badge: '无报错', badgeKind: 'ok' }
                : { kind: 'ok', icon: '✓', title: '运行日志', summary: '本次会话没有记录到错误或警告。', badge: '无报错', badgeKind: 'ok' };
        logItem.actionLabel = '查看日志';
        logItem.onAction = () => { ui.view = 'logs'; ui.navOpen = false; render(); };
        stageItem.actionLabel = '查看指导';
        stageItem.onAction = () => { ui.view = 'guide'; ui.navOpen = false; render(); };

        return card('运行概览',
            muted('这里显示当前聊天的运行状态；只有标为「需要处理」的项目才影响使用。'),
            el('div', { class: 'dga-health-list' }, healthItem(apiItem), healthItem(stageItem), healthItem(logItem)),
        );
    }

    // 改设置的公共入口：写回角色变量并重同步镜像（自动推进/判断AI相关设置都走这里）。
    function saveGuideSettings(patch, success) {
        return runAction('修改自动推进设置', async () => {
            const fresh = await readConfig();
            fresh.settings = { ...(fresh.settings || {}), ...patch };
            await writeConfig(fresh);
            await syncMirrors('normal');
            return true;
        }, { success });
    }

    // 仪表盘「开关」卡（v2.20 起只放通用项：流式输出 + 自动推进三档；
    // 判断AI的 API 预设/频率/段数/提示词都挪到了「动态指导」页）。
    function settingsCard() {
        const config = ui.snapshot ? ui.snapshot.config : null;
        const mode = autoAdvanceMode(config);
        const settings = config && config.settings ? config.settings : {};
        const options = ['off', 'marker', 'judge'].map(value => ({ value, label: AUTO_ADVANCE_LABELS[value] }));
        const basicChildren = [
            toggleRow('开启流式输出', '开启后，支持流式的文本生成会边生成边返回；关闭后会等完整结果返回。（酒馆预设通道不支持流式）', settings.streamingEnabled === true,
                checked => saveGuideSettings({ streamingEnabled: checked }, checked ? '流式输出已开启' : '流式输出已关闭')),
            field('没有写完成条件的阶段怎么进入下一段', selectControl(options, mode, value => {
                saveGuideSettings({ autoAdvance: value }, `自动推进已切换为：${AUTO_ADVANCE_LABELS[value] || value}`);
            })),
            muted('手动推进只能手点「下一段」；标记判断由正文 AI 自己定时机；判断AI用一次静默小请求判定。阶段写「完成：自动」可跨档开 AI 判断。判断AI的详细设置在「动态指导」页。'),
        ];
        // 页签（数据库 AcuSegmentedControl 版式）：基础设置 / 暂未开放。
        const tab = ui.settingsTab === 'other' ? 'other' : 'basic';
        const tabBtn = (key, label) => el('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === key ? 'true' : 'false',
            class: `dga-tab${tab === key ? ' is-on' : ''}`,
            onclick: () => { ui.settingsTab = key; render(); },
        }, label);
        return card('开关',
            muted('基础设置：当前聊天中可随时开关的功能。'),
            el('div', { class: 'dga-tab-bar', role: 'tablist' }, tabBtn('basic', '基础设置'), tabBtn('other', '暂未开放')),
            ...(tab === 'basic' ? basicChildren : [muted('暂未开放。')]),
        );
    }

    // 「动态指导」页的判断AI设置卡（v2.20 从仪表盘挪入）：API 预设 / 多久检查一次 /
    // 参考几段角色回复 / 判断AI提示词入口。只有「判断AI」档才显示具体设置。
    function judgeSettingsCard() {
        const config = ui.snapshot ? ui.snapshot.config : null;
        const mode = autoAdvanceMode(config);
        const settings = config && config.settings ? config.settings : {};
        const presetList = readJudgeApiPresets();
        if (mode !== 'judge') {
            return card('判断AI',
                muted('当前不是「判断AI」档。在仪表盘「开关」里把进入下一段的方式切成「判断AI」后，这里的设置才会生效。'));
        }
        const presetOptions = [{ value: '', label: '酒馆主 API（不使用 API 预设）' }]
            .concat(presetList.map(item => ({ value: item.name, label: item.name })));
        return card('判断AI',
            field('API 预设', selectControl(presetOptions, settings.judgePreset || '', value => {
                saveGuideSettings({ judgePreset: value }, value ? `API 预设已切换为：${value}` : '判断AI改用酒馆主 API');
            })),
            (() => {
                // 数据库填表同款频率制：每层 / 每 2 层 / 每 3 层 / 每 5 层 / 自定义。
                const interval = judgeCheckInterval(settings);
                const presets = [1, 2, 3, 5];
                const selectValue = presets.includes(interval) ? String(interval) : 'custom';
                const intervalInput = el('input', {
                    class: 'dga-input', type: 'number', min: 1, step: 1,
                    onchange: event => {
                        const n = Math.floor(Number(event.target.value));
                        const safe = Number.isFinite(n) && n >= 1 ? n : 1;
                        saveGuideSettings({ judgeInterval: safe }, safe === 1 ? '判断AI改为每层检查' : `判断AI改为每 ${safe} 层检查一次`);
                    },
                });
                intervalInput.value = String(interval);
                return field('多久检查一次（正文之后自动触发）', el('div', { class: 'dga-two-col' },
                    selectControl([
                        { value: '1', label: '每层检查' },
                        { value: '2', label: '每 2 层检查一次' },
                        { value: '3', label: '每 3 层检查一次' },
                        { value: '5', label: '每 5 层检查一次' },
                        { value: 'custom', label: '自定义…' },
                    ], selectValue, value => {
                        if (value === 'custom') {
                            saveGuideSettings({ judgeInterval: presets.includes(interval) ? 4 : interval }, '判断AI检查频率：自定义');
                        } else {
                            saveGuideSettings({ judgeInterval: Number(value) }, value === '1' ? '判断AI改为每层检查' : `判断AI改为每 ${value} 层检查一次`);
                        }
                    }),
                    selectValue === 'custom' ? intervalInput : null,
                ), '正文一到就自动检查，够 N 层才问一次判断AI。');
            })(),
            (() => {
                // 判断时参考最近几段角色回复：只看 AI 正文，用户消息一律不发送。
                const count = judgeHistoryCount(settings);
                const presets = [1, 2, 3, 6];
                const selectValue = presets.includes(count) ? String(count) : 'custom';
                const countInput = el('input', {
                    class: 'dga-input', type: 'number', min: 1, step: 1,
                    onchange: event => {
                        const n = Math.floor(Number(event.target.value));
                        const safe = Number.isFinite(n) && n >= 1 ? n : 1;
                        saveGuideSettings({ judgeHistoryCount: safe }, safe === 1 ? '判断时只看最新 1 段角色回复' : `判断时参考最近 ${safe} 段角色回复`);
                    },
                });
                countInput.value = String(count);
                return field('判断时参考几段角色回复', el('div', { class: 'dga-two-col' },
                    selectControl([
                        { value: '1', label: '只看最新 1 段（默认）' },
                        { value: '2', label: '最近 2 段' },
                        { value: '3', label: '最近 3 段' },
                        { value: '6', label: '最近 6 段' },
                        { value: 'custom', label: '自定义…' },
                    ], selectValue, value => {
                        if (value === 'custom') {
                            saveGuideSettings({ judgeHistoryCount: presets.includes(count) ? 4 : count }, '判断参考段数：自定义');
                        } else {
                            saveGuideSettings({ judgeHistoryCount: Number(value) }, value === '1' ? '判断时只看最新 1 段角色回复' : `判断时参考最近 ${value} 段角色回复`);
                        }
                    }),
                    selectValue === 'custom' ? countInput : null,
                ), '只看 AI 正文，用户消息不发送；选 2 段以上会带更早回复。');
            })(),
            presetList.length === 0
                ? muted('还没有 API 预设。可点左上角目录按钮进入「API」页新建；也可以直接使用酒馆主 API。')
                : null,
            el('div', { class: 'dga-inline-action' },
                btn('判断AI提示词…', () => { ui.view = 'judgePrompt'; ui.judgePromptDraft = null; ui.navOpen = false; render(); }, { ghost: true }),
                el('span', { class: 'dga-muted', text: '提示词与规则在独立页面。' })),
        );
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
            if (context.stage.completion) {
                parts.push(`【进入下一段的条件（由 AI 判断）】\n${context.stage.completion}`);
            } else if (context.stage.autoComplete) {
                parts.push('【进入下一段】\n自动判断：AI 自己判断时机。');
            } else if (context.autoAdvance === 'marker') {
                parts.push('【进入下一段】\nAI 判断时机（标记判断档）。');
            } else if (context.autoAdvance === 'judge') {
                parts.push('【进入下一段】\n判断AI（每条回复多问一次）。');
            } else {
                parts.push('【进入下一段】\n没有写完成条件，只能手动点“下一段”。');
            }
        } else {
            parts.push('现在不发送任何指导。');
        }
        details.append(el('pre', { class: 'dga-pre', text: parts.join('\n\n') }));
        details.append(muted(`显示位置：镜像条目「${mirrorNameFor(entryName(context.entry))}」，${positionText(context.entry.position)}，与原条目同序`));
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
                ? messageBar({ type: 'warning', text: '这个条目还是旧版（1.x）的划分，转换前不会显示指导。在下面选中它，点“转换成新版格式”。' })
                : null,
            !context.legacy && total === 0
                ? messageBar({ type: 'warning', text: '这个条目还没有分阶段，暂时不会显示指导。在下面选中它，点“划分阶段”。' })
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
        children.push(muted('添加后原条目会被关闭，AI 在它原来的位置只能看到当前阶段；点卡片上的「移出」恢复全文。'));
        children.push(row(
            btn('刷新', () => runAction('刷新', async () => {}), { ghost: true }),
            btn('运行诊断', () => runAction('诊断', async () => {
                ui.diagnosis = await collectDiagnostics();
            }), { ghost: true }),
        ));
        return card('添加指导条目', ...children);
    }

    // 诊断卡：逐项体检环境和镜像同步状态，结果可以一键复制发给别人排查。
    function diagnosticsCard() {
        if (!ui.diagnosis) return null;
        const rows = ui.diagnosis;
        const failed = rows.filter(row => !row.ok).length;
        return card('运行诊断',
            muted(failed === 0
                ? `${rows.length} 项全部通过。提示词查看器里找「（动态指导）」条目就能看到当前阶段，位置与原条目一致。还是看不到的话，把这份报告发给作者。`
                : `${rows.length} 项里有 ${failed} 项不通过。把这份报告复制下来发给作者。`),
            el('pre', { class: 'dga-diag' }, diagnosticsText(rows)),
            btn('复制诊断报告', () => runAction('复制诊断报告', async () => {
                const copied = await copyText(diagnosticsText(rows));
                notify(copied ? '诊断报告已复制' : '复制失败：浏览器拦了剪贴板。请直接选中上面的报告文本，长按或 Ctrl+C 复制。', copied ? 'success' : 'error');
            }), { ghost: true }),
        );
    }

    // 脚本跑在 iframe 里，document 没焦点时 navigator.clipboard.writeText 会抛
    // “Document is not focused”。所以先走 textarea + execCommand（点击事件里可用），
    // 失败再试 clipboard API，两头都不行就如实告诉用户。
    async function copyText(text) {
        try {
            const doc = hostDocument();
            const area = doc.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.left = '-9999px';
            area.style.top = '0';
            doc.body.appendChild(area);
            area.focus();
            area.select();
            const ok = doc.execCommand && doc.execCommand('copy');
            area.remove();
            if (ok) return true;
        } catch (error) {
            // 继续试下一种方式
        }
        try {
            const nav = currentWindow.navigator;
            if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
                await nav.clipboard.writeText(text);
                return true;
            }
        } catch (error) {
            // 两种都失败了
        }
        return false;
    }

    function guideCard() {
        return card('三步上手',
            el('ol', { class: 'dga-steps' },
                el('li', {}, '在角色绑定的世界书里新建一个条目，把完整大纲写进去，用空行分开各段。'),
                el('li', {}, '在下面选中这个条目，点“划分阶段”：点一个段落把它设成某一阶段的开头，也可以切到“编辑原文”直接改正文。'),
                el('li', {}, '点“保存并添加”。之后每次聊天，AI 只会收到当前这一段的内容。'),
            ),
            muted('可同时添加多个条目，各自独立推进。也可以直接在正文里写「## 阶段名」分段；写「合并到：阶段名」把这段并进已有阶段。'),
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
        ui.view = 'guide';
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
        if (block.kind === 'stage') return block.completion ? `进入下一段：${block.completion}` : (block.autoComplete ? '进入下一段：自动判断' : '手动点“下一段”推进');
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
                completion: block.autoComplete ? '自动' : (block.completion || ''),
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
                placeholder: '例如：两人完成第一次正式交谈。留空=手动点“下一段”；填“自动”=AI 自己判断。',
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
                placeholder: '例如：两人完成第一次正式交谈。留空=手动点“下一段”；填“自动”=AI 自己判断。',
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
            ui.view = 'guide';
            discardEditor();
            await refresh({ worldbookName: editor.worldbookName, entryKey: entryKey(saved, 0) });
            setMessage('已保存并添加。当前聊天从第一段开始。', 'success');
            return;
        }
        // 已添加的条目：保存后立刻按新正文同步镜像，进度按阶段名自动对上。
        if (editor.bound) await syncMirrors('normal');
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
${P} .dga-health-list { display: flex; flex-direction: column; gap: 10px; }
${P} .dga-health-item { display: grid; grid-template-columns: 30px minmax(0, 1fr) max-content; column-gap: 10px; row-gap: 8px; align-items: center; padding: 10px; border: 1px solid rgba(255, 255, 255, 0.10); border-radius: 11px; background: rgba(255, 255, 255, 0.03); }
${P} .dga-health-item.is-error { border-color: rgba(255, 107, 107, 0.45); }
${P} .dga-health-icon { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: rgba(255, 255, 255, 0.07); opacity: 0.75; font-size: 0.9rem; font-weight: 700; }
${P} .dga-health-item.is-ok .dga-health-icon { color: #7fd88f; background: rgba(127, 216, 143, 0.12); opacity: 1; }
${P} .dga-health-item.is-warning .dga-health-icon { color: #ffd479; background: rgba(255, 212, 121, 0.12); opacity: 1; }
${P} .dga-health-item.is-error .dga-health-icon { color: #ff8a8a; background: rgba(255, 138, 138, 0.12); opacity: 1; }
${P} .dga-health-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
${P} .dga-health-body strong { font-size: 0.88rem; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${P} .dga-health-body p { margin: 0; font-size: 0.78rem; opacity: 0.65; line-height: 1.5; overflow-wrap: anywhere; }
${P} .dga-health-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; justify-self: end; }
${P} .dga-badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; background: rgba(255, 255, 255, 0.08); opacity: 0.85; white-space: nowrap; }
${P} .dga-badge.is-ok { color: #7fd88f; background: rgba(127, 216, 143, 0.12); opacity: 1; }
${P} .dga-badge.is-error { color: #ff8a8a; background: rgba(255, 138, 138, 0.14); opacity: 1; }
${P} .dga-badge.is-idle { opacity: 0.55; }
${P} .dga-health-action { background: none; border: none; color: inherit; font: inherit; font-size: 0.76rem; opacity: 0.7; cursor: pointer; padding: 2px 0; white-space: nowrap; }
${P} .dga-health-action:hover { opacity: 1; text-decoration: underline; }
${P} .dga-toggle-row { display: flex; flex-direction: column; gap: 4px; }
${P} .dga-toggle-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
${P} .dga-toggle-label { font-size: 0.9rem; font-weight: 500; }
${P} .dga-toggle-desc { margin: 0; font-size: 0.76rem; line-height: 1.5; opacity: 0.6; }
${P} .dga-switch { appearance: none; -webkit-appearance: none; width: 38px; height: 22px; border-radius: 999px; background: rgba(255, 255, 255, 0.14); position: relative; cursor: pointer; flex: 0 0 auto; transition: background 0.15s ease; margin: 0; }
${P} .dga-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: rgba(255, 255, 255, 0.85); transition: left 0.15s ease; }
${P} .dga-switch:checked { background: var(--SmartThemeQuoteColor, #7a68c8); }
${P} .dga-switch:checked::after { left: 19px; }
${P} .dga-switch:disabled { opacity: 0.5; cursor: not-allowed; }
${P} .dga-tab-bar { display: flex; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px; overflow: hidden; }
${P} .dga-tab { flex: 1; padding: 8px 0; background: transparent; border: none; color: inherit; font: inherit; font-size: 0.86rem; cursor: pointer; opacity: 0.6; min-height: 36px; }
${P} .dga-tab.is-on { background: rgba(255, 255, 255, 0.10); opacity: 1; font-weight: 600; }
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
${P} .dga-diag { margin: 0; padding: 10px 12px; max-height: 260px; overflow: auto; border-radius: 10px; background: rgba(0, 0, 0, 0.28); font-size: 0.78rem; line-height: 1.6; white-space: pre-wrap; word-break: break-all; user-select: text; }
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
${P} .dga-nav-backdrop { position: absolute; inset: 0; z-index: 3; display: flex; background: rgba(0, 0, 0, 0.55); }
${P} .dga-nav-drawer { width: 250px; max-width: 84%; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 22px 12px 16px; background: var(--SmartThemeBlurTintColor, #1b1d24); border-right: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 12px 0 40px rgba(0, 0, 0, 0.45); animation: dga-nav-in 0.18s ease-out; }
@keyframes dga-nav-in { from { transform: translateX(-28px); opacity: 0; } to { transform: none; opacity: 1; } }
${P} .dga-nav-brand { display: flex; align-items: center; gap: 10px; padding: 4px 4px 18px; margin-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
${P} .dga-nav-brand-mark { width: 34px; height: 34px; flex: 0 0 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; background: var(--SmartThemeQuoteColor, #7c6cf0); color: #fff; font-size: 13px; font-weight: 700; letter-spacing: 0.04em; }
${P} .dga-nav-brand-copy { min-width: 0; display: block; }
${P} .dga-nav-brand-title { display: block; font-size: 15px; font-weight: 700; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${P} .dga-nav-brand-tag { display: block; margin-top: 3px; font-size: 11px; opacity: 0.6; }
${P} .dga-nav-group-title { padding: 7px 12px 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; opacity: 0.55; }
${P} .dga-nav-group { display: flex; flex-direction: column; gap: 2px; }
${P} .dga-nav-item { display: block; width: 100%; min-height: 40px; padding: 10px 12px; border: 0; border-radius: 10px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; opacity: 0.85; transition: background 0.15s ease, opacity 0.15s ease; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-nav-item:not(.is-on):hover { background: rgba(255, 255, 255, 0.08); opacity: 1; }
${P} .dga-nav-item.is-on { background: var(--SmartThemeQuoteColor, #7c6cf0); color: #fff; font-weight: 700; opacity: 1; }
${P} .dga-nav-item:disabled { opacity: 0.35; cursor: default; }
${P} .dga-icon-btn { width: 44px; min-width: 44px; min-height: 44px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 11px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.07); color: inherit; font: inherit; font-size: 1.05rem; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-icon-btn:hover { background: rgba(255, 255, 255, 0.14); }
${P} .dga-icon-btn:disabled { opacity: 0.35; cursor: default; }
${P} .dga-icon-btn.dga-icon-danger { color: #ff9b9b; border-color: rgba(255, 120, 120, 0.35); }
${P} .dga-api-select-row { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content max-content; gap: 6px; align-items: stretch; }
${P} .dga-api-select-row select { width: 100%; }
${P} .dga-inline-action { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
${P} .dga-inline-action .dga-btn { flex: 0 0 auto; min-height: 40px; padding: 8px 14px; }
${P} .dga-two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
${P} .dga-api-actions { display: flex; justify-content: flex-end; gap: 8px; }
${P} .dga-api-actions .dga-btn { flex: 0 1 auto; min-height: 40px; padding: 8px 16px; }
${P} .dga-field-hint { font-size: 0.78rem; opacity: 0.6; line-height: 1.5; }
${P} .dga-model-pick-arrow { color: var(--SmartThemeQuoteColor, #7c6cf0); font-size: 0.85rem; font-weight: 700; margin-bottom: 4px; animation: dga-pick-bounce 1.2s ease-in-out infinite; }
@keyframes dga-pick-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
${P} .dga-pseg { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.09); }
${P} .dga-pseg:last-of-type { border-bottom: 0; padding-bottom: 0; }
${P} .dga-pseg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
${P} .dga-pseg-index { font-size: 0.78rem; opacity: 0.55; min-width: 26px; font-family: monospace; }
${P} .dga-pseg-head select { flex: 1 1 110px; max-width: 180px; min-height: 36px; }
${P} .dga-pseg-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
${P} .dga-pseg-actions .dga-icon-btn { width: 36px; min-width: 36px; min-height: 36px; font-size: 0.95rem; }
${P} .dga-pseg-add { display: flex; justify-content: center; }
${P} .dga-pseg-add .dga-btn { min-height: 36px; padding: 6px 14px; font-size: 0.85rem; }
${P} .dga-rule-group { border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 11px; overflow: hidden; }
${P} .dga-rule-head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 8px 12px; border: 0; background: rgba(255, 255, 255, 0.04); color: inherit; font: inherit; font-size: 0.88rem; font-weight: 600; text-align: left; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
${P} .dga-rule-head:hover { background: rgba(255, 255, 255, 0.08); }
${P} .dga-rule-chevron { font-size: 0.75rem; opacity: 0.6; transition: transform 0.15s ease; }
${P} .dga-rule-chevron.is-open { transform: rotate(90deg); }
${P} .dga-rule-label { flex: 1; }
${P} .dga-rule-count { font-size: 0.75rem; font-weight: 400; opacity: 0.55; }
${P} .dga-rule-body { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-top: 1px solid rgba(255, 255, 255, 0.09); }
${P} .dga-rule-row { display: flex; align-items: center; gap: 6px; }
${P} .dga-rule-row .dga-input { flex: 1; min-width: 0; }
${P} .dga-rule-sep { flex-shrink: 0; font-size: 0.75rem; opacity: 0.55; }
${P} .dga-rule-empty { padding: 8px; text-align: center; font-size: 0.78rem; opacity: 0.55; }
${P} .dga-rule-add { display: flex; }
${P} .dga-rule-add .dga-btn { min-height: 36px; padding: 6px 14px; font-size: 0.85rem; }
${P} .dga-rule-tester { display: flex; flex-direction: column; gap: 8px; }
${P} .dga-rule-tester-title { font-size: 0.82rem; font-weight: 600; opacity: 0.75; }
${P} .dga-rule-tester-actions { display: flex; gap: 8px; flex-wrap: wrap; }
${P} .dga-rule-tester-actions .dga-btn { min-height: 34px; padding: 5px 12px; font-size: 0.8rem; }
${P} .dga-rule-tester-result { display: flex; flex-direction: column; gap: 6px; }
${P} .dga-rule-tester-verdict { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
${P} .dga-verdict { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }
${P} .dga-verdict.is-yes { background: rgba(34, 197, 94, 0.2); color: #7ce7a2; }
${P} .dga-verdict.is-no { background: rgba(239, 68, 68, 0.18); color: #ff9b9b; }
${P} .dga-rule-tester-filtered { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.28); font-family: monospace; font-size: 0.76rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow-y: auto; }
${P} .dga-log-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
${P} .dga-log-toolbar select { flex: 0 1 140px; min-height: 38px; }
${P} .dga-log-debug-toggle { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; opacity: 0.8; cursor: pointer; }
${P} .dga-log-debug-toggle input { width: 16px; height: 16px; margin: 0; }
${P} .dga-log-list { display: flex; flex-direction: column; gap: 2px; font-family: monospace; font-size: 0.78rem; }
${P} .dga-log-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 7px; }
${P} .dga-log-row:nth-child(odd) { background: rgba(255, 255, 255, 0.03); }
${P} .dga-log-time { flex-shrink: 0; opacity: 0.5; }
${P} .dga-log-level { flex-shrink: 0; min-width: 30px; font-weight: 700; }
${P} .dga-log-level-info { color: #7cc4ff; }
${P} .dga-log-level-warn { color: #ffcf7c; }
${P} .dga-log-level-error { color: #ff9b9b; }
${P} .dga-log-level-debug { color: #b8a8ff; }
${P} .dga-log-tag { flex-shrink: 0; opacity: 0.65; }
${P} .dga-log-text { overflow-wrap: anywhere; white-space: pre-wrap; }
${P} .dga-danger-text { color: #ff9b9b; font-size: 0.85rem; overflow-wrap: anywhere; }
${P} input[type="number"], ${P} input[type="password"] { width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 11px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(0, 0, 0, 0.26); color: inherit; font: inherit; }
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
        normalizeConfig,
        normalizeJudgeApiPreset,
        normalizeJudgeApiPresets,
        normalizePromptPostProcessing,
        normalizeExcludeBodyParams,
        normalizeNativeProxyBase,
        buildJudgeCustomRequestBody,
        judgeTextFromJson,
        parseJudgeSseText,
        fetchAvailableModels,
        readTavernConnectionProfiles,
        judgeMessagesFor,
        judgeSaysYes,
        applyJudgeOutputRules,
        applyBoundaryRules,
        previewJudgeOutput,
        getJudgeRuntime: () => ({ ...judgeRuntime }),
        normalizeRulePairs: RuleModule.normalize,
        log: LogModule,
        pickLoad,
        pickBuild,
        pickAssign,
        pickRemove,
        openEditorAt,
        openManager,
        refresh: () => runAction('刷新', async () => {}),
        sync: () => syncMirrors('normal'),
        mirrorNameFor,
        next,
        previous,
        reset,
        add: (worldbookName, entry, options) => addBinding(worldbookName, entry, options),
        unbind: (key, options) => unbindEntry(key, options),
        getCurrentSnapshot: loadContexts,
        diagnose: collectDiagnostics,
    };
    currentWindow.DynamicGuideAssistantCore = publicApi;

    if (!helper) {
        LogModule.warn('系统', '未检测到酒馆助手；只开放解析函数');
        console.warn(`[${SCRIPT_NAME}] 未检测到酒馆助手；只开放解析函数。`);
        return;
    }

    LogModule.info('系统', `${SCRIPT_NAME} v${VERSION} 已加载`);
    removeStaleUi();
    registerMenuEntry(0);
    // 页面一打开就清掉旧版注入残留，并把镜像同步到当前进度。
    // 镜像条目存在世界书里、跨重载有效，第一次生成前同步完即可。
    runEventTask('准备指导', async () => {
        await clearLegacyInjections();
        await syncMirrors('startup');
    });

    const eventOn = api('eventOn', false);
    const events = apiValue('tavern_events');
    if (!eventOn || !events) {
        reportOnce('events', '当前酒馆助手缺少事件接口，管理页可以用，但无法自动同步当前阶段。');
        return;
    }
    if (events.GENERATION_AFTER_COMMANDS) {
        eventOn(events.GENERATION_AFTER_COMMANDS, function (type, params, dryRun) {
            // 不跳过 dryRun：提示词查看器等预组装也必须看到当前镜像内容。
            // SillyTavern 会等待这个事件监听器返回的 Promise。必须把同步任务返回，
            // 否则世界书读取尚未完成，请求就已经继续组装，镜像调整（如 swipe 回退）赶不上本次生成。
            return runEventTask('同步当前阶段', () => syncMirrors(type));
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
            // 换聊天后进度不同：镜像内容按新聊天的进度重新对齐（镜像在世界书里，不按聊天隔离）。
            LogModule.info('事件', '切换聊天，按新聊天的进度重新对齐镜像');
            await syncMirrors('normal');
            const doc = hostDocument();
            const panel = doc && doc.getElementById(PANEL_ID);
            if (panel && !panel.hidden) await runAction('刷新', async () => {});
        }));
    }
})();
