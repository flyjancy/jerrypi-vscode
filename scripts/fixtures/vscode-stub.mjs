// 假的 `vscode` 模块 —— 只为 `scripts/host-check.mjs` 而存在。
//
// 三条纪律（评审第 2 轮定的，违了就白测）：
//
//   1. **桩里不写任何判断逻辑**：它只做两件事 —— 记录调用、按预置脚本返回。
//      一旦桩里出现 `if (…) return …` 这种业务判断，测的就是桩而不是产品代码。
//   2. **驱动端必须是真输入**：测试要用一条真实的 webview 消息 / 一条会话事件去驱动，
//      再从桩上读结果。像"我调一下 `updateStatusBar(x)` 再断言桩记到了 `x`"这种，
//      是在测赋值语句，不是测行为。
//   3. **状态挂在 `globalThis` 上**：esbuild 会把这个文件**内联**进被测 bundle，
//      而检查脚本又会单独 import 一份 —— 两个模块实例必须共享同一份状态。
//      所以真正的存储是 `globalThis.__jerrypiVscodeStub`，本文件只是它的门面。
//
// 只实现"宿主代码真的碰到"的成员（评审按这个标准裁的接口面）。缺什么补什么，
// 不要预先铺开整个 vscode API。

const KEY = "__jerrypiVscodeStub";

function state() {
  globalThis[KEY] ??= {
    calls: [],
    commands: new Map(),
    statusBars: [],
    quickPickQueue: [],
    inputBoxAnswers: [],
    warningQueue: [],
    informationQueue: [],
    configuration: new Map(),
    configurationListeners: [],
    outputChannels: new Map(),
    contentProviders: new Map(),
    // S8：`workspace.workspaceFolders` 也挂在共享状态里 —— 桩文件会被 esbuild**内联**进
    // 被测 bundle（见文件头第 3 条），而检查脚本里直接改导出的对象只改到它自己那份副本。
    workspaceFolders: [],
  };
  return globalThis[KEY];
}

/** 取某个 scheme 注册过的虚拟文档 provider（断言用）。 */
export function contentProviderOf(scheme) {
  return state().contentProviders.get(scheme);
}

/** 预置工作区文件夹（S8 的 `Pi: Project Trust…` 命令靠 `workspaceCwd()`）。 */
export function setWorkspaceFolders(folders) {
  state().workspaceFolders = folders;
}

/** 清空全部记录（每个断言块之前调用）。 */
export function resetStub() {
  globalThis[KEY] = undefined;
}

/** 全部调用记录，按发生顺序。 */
export function stubCalls() {
  return state().calls;
}

/** 按种类筛选记录。 */
export function callsOf(kind) {
  return state().calls.filter((call) => call.kind === kind);
}

/** 预置下一次 `showQuickPick` 的返回值：一个 item、一个下标，或一个函数。 */
export function queueQuickPickResponse(response) {
  state().quickPickQueue.push(response);
}

/** 预置下一次 `showInputBox` 的返回值。 */
export function queueInputBoxAnswer(answer) {
  state().inputBoxAnswers.push(answer);
}

/**
 * 预置下一次 `showWarningMessage` 的返回值（用户点了哪个按钮，或 undefined = 取消）。
 * S5 的"忙时切会话要问一句"就靠它。
 */
export function queueWarningResponse(response) {
  state().warningQueue.push(response);
}

/** 预置下一次 `showInformationMessage` 的返回值（S6：改设置后提示"要重载窗口"）。 */
export function queueInformationResponse(response) {
  state().informationQueue.push(response);
}

/** 预置某个配置段的取值（S6 的三项设置）：`queueConfiguration("jerrypi", { agentDir: "/x" })`。 */
export function queueConfiguration(section, values) {
  state().configuration.set(section, values);
}

/** 触发一次配置变更事件（模拟用户改了设置）。 */
export async function fireConfigurationChange(...affected) {
  for (const listener of state().configurationListeners) {
    await listener({ affectsConfiguration: (key) => affected.includes(key) });
  }
}

function record(kind, payload = {}) {
  state().calls.push({ kind, ...payload });
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

export class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    this._fn?.();
  }
  static from(...items) {
    return new Disposable(() => {
      for (const item of items) item?.dispose?.();
    });
  }
}

/**
 * 真 vscode 的 `Uri` 语义（S7 A3 要断言的正是这几条）：
 *   - `parse("s:/a%20b?q#f")` → scheme=s、path **解码**成 `/a b`、query/q、fragment/f；
 *     解析顺序是**先 `#` 后 `?`**（`?` 在 fragment 里不再是分隔符）；
 *   - `from({scheme, path, query})` 按组件收，`toString()` 时才编码 —— 所以 path 里的
 *     `#`/`?`/空格**不会**被当成 fragment/query（`chatView.ts:230` 那个坑的根源就是
 *     "拿整串去 parse"）。
 */
export class Uri {
  constructor(schemeOrWhole, path, query, fragment) {
    if (path === undefined && query === undefined && fragment === undefined && typeof schemeOrWhole === "string" && schemeOrWhole.includes(":")) {
      const parsed = Uri.parse(schemeOrWhole);
      this.scheme = parsed.scheme;
      this.path = parsed.path;
      this.query = parsed.query;
      this.fragment = parsed.fragment;
      return;
    }
    this.scheme = schemeOrWhole ?? "";
    this.path = path ?? "";
    this.query = query;
    this.fragment = fragment;
  }
  static file(p) {
    return new Uri("file", p);
  }
  /**
   * 真 vscode-uri 的 `fsPath`：`file:` URI 的本地路径。
   *
   * ⚠️ 桩上一版**没有**这个成员（S8 第 5 步才发现）：`workspaceCwd()` 读的是
   * `folder.uri.fsPath`，于是它静默返回 `undefined`，命令拿 `undefined` 当 cwd 去问 pi，
   * 在 pi 内部才炸 —— 桩缺一个成员时，坏的是**被测代码看到的输入**。
   */
  get fsPath() {
    return this.scheme === "file" ? String(this.path) : String(this.path);
  }
  static parse(s) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
    if (m === null) return new Uri("", s);
    return new Uri(
      m[1],
      decodeURIComponent(m[2] ?? ""),
      m[3] === undefined ? undefined : decodeURIComponent(m[3]),
      m[4] === undefined ? undefined : decodeURIComponent(m[4]),
    );
  }
  static from(components) {
    return new Uri(components.scheme, components.path ?? "", components.query, components.fragment);
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ""), ...parts].join("/"), base.query, base.fragment);
  }
  toString() {
    const encodedPath = String(this.path)
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    // 真 vscode-uri 的规则：`file:` scheme（或有 authority）时写 `//` → `file:///w/x`。
    const useSlashes = this.scheme === "file" || (this.authority ?? "") !== "";
    let out = `${this.scheme}:${useSlashes ? "//" : ""}${encodedPath}`;
    // query 只挡 `#` 与空格（真 vscode 也保留 `=`/`&`）
    if (this.query !== undefined) out += `?${String(this.query).replace(/#/g, "%23").replace(/ /g, "%20")}`;
    if (this.fragment !== undefined) out += `#${encodeURIComponent(this.fragment)}`;
    return out;
  }
}

export class CancellationTokenSource {
  constructor() {
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: () => new Disposable(() => {}),
    };
  }
  cancel() {}
  dispose() {}
}

export class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return new Disposable(() => {});
    };
  }
  fire(value) {
    for (const fn of this.listeners) fn(value);
  }
  dispose() {}
}

/** 记录型 OutputChannel（宿主自己 `createOutputChannel` 时用）。 */
function makeOutputChannel(name) {
  const channel = {
    name,
    lines: [],
    appendLine(line) {
      channel.lines.push(line);
    },
    append(line) {
      channel.lines.push(line);
    },
    replace() {},
    clear() {
      channel.lines.length = 0;
    },
    show() {},
    hide() {},
    dispose() {},
  };
  return channel;
}

export const window = {
  async showQuickPick(items, options = {}) {
    // 真 vscode 支持传 Thenable（S4 的 D7 就靠这个），这里必须 await 出真实列表。
    const resolved = await items;
    record("showQuickPick", { items: resolved, options });
    if (state().quickPickQueue.length === 0) return undefined; // 默认：按 Esc 取消
    const next = state().quickPickQueue.shift();
    return typeof next === "function" ? next(resolved) : next;
  },
  createStatusBarItem(alignment, priority) {
    const item = {
      alignment,
      priority,
      text: "",
      tooltip: "",
      command: undefined,
      visible: false,
      shownCount: 0,
      hiddenCount: 0,
      show() {
        item.visible = true;
        item.shownCount += 1;
      },
      hide() {
        item.visible = false;
        item.hiddenCount += 1;
      },
      dispose() {
        record("statusBar.dispose", {});
      },
    };
    state().statusBars.push(item);
    record("createStatusBarItem", { alignment, priority });
    return item;
  },
  createOutputChannel(name) {
    const channel = makeOutputChannel(name);
    state().outputChannels.set(name, channel);
    return channel;
  },
  showWarningMessage(message, options, ...items) {
    // 真 vscode 的形状：`showWarningMessage(message, options?, ...items)`；
    // 带 items 时返回被点的那个（或 undefined = 取消/Esc）。
    record("showWarningMessage", { message, options, items });
    const queued = state().warningQueue.shift();
    return Promise.resolve(typeof queued === "function" ? queued(items) : queued);
  },
  showErrorMessage(message) {
    record("showErrorMessage", { message });
    return Promise.resolve(undefined);
  },
  showInformationMessage(message, ...items) {
    // 真 vscode 的形状：`showInformationMessage(message, ...items)`（S6 的"要重载窗口"提示靠它）。
    record("showInformationMessage", { message, items });
    const queued = state().informationQueue.shift();
    return Promise.resolve(typeof queued === "function" ? queued(items) : queued);
  },
  showInputBox(options) {
    record("showInputBox", { options });
    return Promise.resolve(state().inputBoxAnswers.shift());
  },
  showTextDocument(uri, options) {
    // 两种调用形都有：`showTextDocument(Uri)`（chatView 打开工具写的文件）与
    // `showTextDocument(文档对象)`（`openTextDocument(uri)` 的返回）。
    record("showTextDocument", { uri: uri?.uri?.toString?.() ?? uri?.toString?.() ?? String(uri), options });
    return Promise.resolve({ uri });
  },
  registerWebviewViewProvider(id, provider, options) {
    record("registerWebviewViewProvider", { id, provider, options });
    return new Disposable(() => {});
  },
};

export const commands = {
  registerCommand(id, handler) {
    state().commands.set(id, handler);
    record("registerCommand", { id });
    return new Disposable(() => state().commands.delete(id));
  },
  async executeCommand(id, ...args) {
    record("executeCommand", { id, args });
    const handler = state().commands.get(id);
    return handler === undefined ? undefined : await handler(...args);
  },
  getCommands() {
    return Promise.resolve([...state().commands.keys()]);
  },
};

export const env = {
  openExternal(uri) {
    record("openExternal", { href: uri?.toString?.() ?? String(uri) });
    return Promise.resolve(true);
  },
};

export const version = "0.0.0-stub";

export const workspace = {
  /** 真 vscode 里这是个只读属性；这里读共享状态，于是"检查脚本改一份、产品代码看另一份"不可能发生。 */
  get workspaceFolders() {
    return state().workspaceFolders;
  },
  getConfiguration(section) {
    record("getConfiguration", { section });
    const values = state().configuration.get(section) ?? {};
    // 真 vscode 的语义：`getConfiguration("a").get("b")` 查的是 **`a.b`**。
    // 所以这里按 `${section}.${key}` 查 —— “把完整 id 当 key 传”的写法会像真机一样查不到。
    // （S6 第一版就是这个 bug，而当时的桩不区分这两种写法，于是自动门禁全绿；M1 真机一跑就露馅。）
    const flat = {};
    for (const [key, value] of Object.entries(values)) flat[`${section}.${key}`] = value;
    return {
      get: (key, fallback) => {
        const id = `${section}.${key}`;
        return Object.hasOwn(flat, id) ? flat[id] : fallback;
      },
      update: () => Promise.resolve(),
    };
  },
  registerTextDocumentContentProvider(scheme, provider) {
    record("registerTextDocumentContentProvider", { scheme });
    state().contentProviders.set(scheme, provider);
    return new Disposable(() => state().contentProviders.delete(scheme));
  },
  onDidChangeConfiguration(listener) {
    record("onDidChangeConfiguration", {});
    state().configurationListeners.push(listener);
    return new Disposable(() => {
      const at = state().configurationListeners.indexOf(listener);
      if (at >= 0) state().configurationListeners.splice(at, 1);
    });
  },
  fs: {
    readFile: () => Promise.resolve(new Uint8Array()),
    writeFile: () => Promise.resolve(),
    stat: () => Promise.resolve({}),
  },
  openTextDocument: (uri) => Promise.resolve({ uri }),
};

export const extensions = { getExtension: () => undefined };
export const ExtensionContext = class {};
export const WebviewViewProvider = class {};
export const WebviewView = class {};
export const OutputChannel = class {};
