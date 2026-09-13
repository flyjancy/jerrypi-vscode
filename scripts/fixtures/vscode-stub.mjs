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
    outputChannels: new Map(),
  };
  return globalThis[KEY];
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

export class Uri {
  constructor(value) {
    this.value = value;
  }
  static file(p) {
    return new Uri(`file://${p}`);
  }
  static parse(s) {
    return new Uri(s);
  }
  static joinPath(base, ...parts) {
    return new Uri([base.value.replace(/\/$/, ""), ...parts].join("/"));
  }
  toString() {
    return this.value;
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
  showWarningMessage(message) {
    record("showWarningMessage", { message });
    return Promise.resolve(undefined);
  },
  showErrorMessage(message) {
    record("showErrorMessage", { message });
    return Promise.resolve(undefined);
  },
  showInformationMessage(message) {
    record("showInformationMessage", { message });
    return Promise.resolve(undefined);
  },
  showInputBox(options) {
    record("showInputBox", { options });
    return Promise.resolve(state().inputBoxAnswers.shift());
  },
  showTextDocument(uri, options) {
    record("showTextDocument", { uri: uri?.toString?.() ?? String(uri), options });
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
  workspaceFolders: [],
  getConfiguration() {
    return { get: (_key, fallback) => fallback, update: () => Promise.resolve() };
  },
  fs: {
    readFile: () => Promise.resolve(new Uint8Array()),
    writeFile: () => Promise.resolve(),
    stat: () => Promise.resolve({}),
  },
  openTextDocument: () => Promise.resolve({}),
};

export const extensions = { getExtension: () => undefined };
export const ExtensionContext = class {};
export const WebviewViewProvider = class {};
export const WebviewView = class {};
export const OutputChannel = class {};
