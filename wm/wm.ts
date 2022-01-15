// This file is pretty messy, it is just a prototype for now!

const x11: IX11Mod = require("x11"); // eslint-disable-line

import { app, ipcMain, BrowserWindow } from "electron";
import type { IBounds, IWindow } from "../shared/reducers";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { Mutable } from "type-fest";
import { log, logDir, logError } from "./log";
import { configureStore, ServerRootState, ServerStore } from "./configureStore";
import {
  X11_EVENT_TYPE,
  X11_KEY_MODIFIER,
  IXEvent,
  IXConfigureEvent,
  IXScreen,
  IXDisplay,
  IXClient,
  IXKeyEvent,
  XCbWithErr,
  XGeometry,
  XWindowAttrs,
  IXPropertyNotifyEvent,
  XMapState,
  XCB_EVENT_MASK_NO_EVENT,
  IX11Mod,
  XEventMask,
  IX11Client,
  XFocusRevertTo,
  PointerRoot,
} from "../shared/X";
import * as actions from "../shared/actions";
import { Middleware } from "redux";
import { batch } from "react-redux";
import { anyIntersect } from "../shared/utils";
import { requireExt as requireXinerama } from "./xinerama";
import { createEWMHEventConsumer } from "./ewmh";
import { getPropertyValue, internAtomAsync } from "./xutils";
import { getScreenIndexWithCursor } from "./pointer";
import { createICCCMEventConsumer, getNormalHints } from "./icccm";

interface Geometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

// The values here are arbitrary; we call InternAtom to get the true constants.
export const ExtraAtoms = {
  UTF8_STRING: -1,

  WM_PROTOCOLS: 10000,
  WM_DELETE_WINDOW: 10001,

  _NET_WM_NAME: 340,
};

const NO_EVENT_MASK = 0;

const ROOT_WIN_EVENT_MASK =
  x11.eventMask.SubstructureRedirect |
  x11.eventMask.SubstructureNotify |
  x11.eventMask.EnterWindow |
  x11.eventMask.LeaveWindow |
  x11.eventMask.StructureNotify |
  x11.eventMask.ButtonPress |
  x11.eventMask.ButtonRelease |
  x11.eventMask.FocusChange |
  x11.eventMask.PropertyChange;

const FRAME_WIN_EVENT_MASK =
  x11.eventMask.StructureNotify |
  x11.eventMask.EnterWindow |
  x11.eventMask.LeaveWindow |
  x11.eventMask.SubstructureRedirect;

const CLIENT_WIN_EVENT_MASK = x11.eventMask.StructureNotify | x11.eventMask.PropertyChange | x11.eventMask.FocusChange;

export enum XWMWindowType {
  Other = 0,
  Client = 1,
  Frame = 2,
  Desktop = 3,
}

export interface XWMEventConsumerArgs {
  wid: number;
}

export interface XWMEventConsumerArgsWithType extends XWMEventConsumerArgs {
  windowType: XWMWindowType;
}

export interface XWMEventConsumerSetFrameExtentsArgs extends XWMEventConsumerArgs {
  frameExtents: IBounds;
}

export interface IXWMEventConsumer {
  onMapNotify?(args: XWMEventConsumerArgsWithType): void;
  onUnmapNotify?(args: XWMEventConsumerArgsWithType): void;

  onSetFrameExtents?(args: XWMEventConsumerSetFrameExtentsArgs): void;
}

export interface XWMContext {
  X: IXClient;
  XDisplay: IXDisplay;
  store: ServerStore;
}

export function startX(): XServer {
  return createServer();
}

export class XServer {
  // Could put a teardown method here.
}

export function createServer(): XServer {
  const server = new XServer();
  let client: IX11Client;

  let XDisplay: IXDisplay;
  let X: IXClient;

  const eventConsumers: IXWMEventConsumer[] = [];

  const knownWids = new Set<number>();
  const winIdToRootId: { [wid: number]: number } = {};

  const desktopBrowsers: BrowserWindow[] = [];
  /** Desktop window handle to index into `desktopBrowsers`. */
  const desktopBrowserHandles: { [did: number]: number } = {};

  const frameBrowserWindows: { [wid: number]: BrowserWindow | undefined } = {};
  const frameBrowserWinIdToFrameId: { [wid: number]: number | undefined } = {};
  const frameBrowserFrameIdToWinId: { [fid: number]: number | undefined } = {};

  const initializingWins: { [win: number]: boolean } = {};

  const store = __setupStore();

  const context: XWMContext = {
    X,
    XDisplay,
    store,
  };

  // If `true`, send to the desktop browser.
  // If a function, execute when pressed.
  const registeredKeys: {
    [keyModifiers: number]: { [keyCode: number]: boolean | VoidFunction };
  } = {
    [X11_KEY_MODIFIER.Mod4Mask]: {
      // Mod4 + O
      32: () => sendActiveWindowToNextScreen(),

      // Mod4 + R
      27: true,

      // Mod4 + Enter, TODO: launch default/configurable terminal.
      36: () => launchProcess("urxvt"),
    },
    [X11_KEY_MODIFIER.Mod4Mask | X11_KEY_MODIFIER.ShiftMask]: {
      // Mod4 + Shift + C
      54: () => closeFocusedWindow(),
      // Mod4 + Shift + Q
      24: () => app.quit(),
    },
    [X11_KEY_MODIFIER.Mod4Mask | X11_KEY_MODIFIER.ControlMask]: {
      // Mod4 + Ctrl + R
      27: () => {
        app.relaunch();
        app.exit(0);
      },
    },
  };

  // Initialization.
  (() => {
    client = x11.createClient(async (err: unknown, display: IXDisplay) => {
      if (err) {
        logError(err);
        process.exit(1);
      }

      XDisplay = context.XDisplay = display;
      X = context.X = display.client;

      eventConsumers.push(await createICCCMEventConsumer(context));
      eventConsumers.push(await createEWMHEventConsumer(context));

      await __setupAtoms();
      await __initDesktop();
    });

    client.on("error", (err: unknown) => {
      logError(err);
    });

    client.on("event", __onXEvent);

    ipcMain.on("raise-window", (event, wid) => {
      raiseWindow(wid);
    });

    ipcMain.on("minimize-window", (event, wid) => {
      minimize(wid);
    });

    ipcMain.on("close-window", (event, wid) => {
      closeWindow(wid);
    });

    ipcMain.on("exec", (event, args) => {
      launchProcess(args.executable);
    });

    ipcMain.on("show-desktop-dev-tools", (event, args: { screenIndex: number }) => {
      desktopBrowsers[args.screenIndex]?.webContents?.openDevTools();
    });
  })();

  async function __setupAtoms(): Promise<void> {
    // TODO: Typings are a little awkward here.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const extraAtoms = ExtraAtoms as Mutable<typeof ExtraAtoms>;
    extraAtoms.UTF8_STRING = (await internAtomAsync(X, "UTF8_STRING")) as any;

    extraAtoms.WM_PROTOCOLS = (await internAtomAsync(X, "WM_PROTOCOLS")) as any;
    extraAtoms.WM_DELETE_WINDOW = (await internAtomAsync(X, "WM_DELETE_WINDOW")) as any;

    extraAtoms._NET_WM_NAME = (await internAtomAsync(X, "_NET_WM_NAME")) as any;

    log("ExtraAtoms", extraAtoms);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  async function __initDesktop(): Promise<void> {
    for (const screen of XDisplay.screen) {
      await __initScreen(screen);
    }
  }

  async function __initScreen(screen: IXScreen): Promise<void> {
    const root = screen.root;

    const debugScreen = Object.assign({}, screen);
    delete debugScreen.depths;
    log("Processing X screen", debugScreen);

    X.GrabServer();

    changeWindowEventMask(root, ROOT_WIN_EVENT_MASK);

    X.UngrabServer();

    const logicalScreens = await getScreenGeometries(screen);
    log("Obtained logical screens", logicalScreens);

    for (const logicalScreen of logicalScreens) {
      store.dispatch(
        actions.addScreen({
          x: logicalScreen.x,
          y: logicalScreen.y,
          width: logicalScreen.width,
          height: logicalScreen.height,
          root,
        })
      );

      const did = createDesktopBrowser({
        width: logicalScreen.width,
        height: logicalScreen.height,
      });

      X.ConfigureWindow(did, {
        borderWidth: 0,
        width: logicalScreen.width,
        height: logicalScreen.height,
      });

      X.ReparentWindow(did, root, logicalScreen.x, logicalScreen.y);
    }

    X.QueryTree(root, (err, tree) => {
      tree.children.forEach((childWid) => manageWindow(childWid, 0, true));
    });

    __setupKeyShortcuts(root);

    X.SetInputFocus(PointerRoot, XFocusRevertTo.PointerRoot);
  }

  function __setupKeyShortcuts(rootWid: number) {
    for (const modifier in registeredKeys) {
      if (!registeredKeys.hasOwnProperty(modifier)) continue;

      for (const key in registeredKeys[modifier]) {
        if (!registeredKeys[modifier].hasOwnProperty(key)) continue;

        X.GrabKey(rootWid, true, parseInt(modifier, 10), parseInt(key, 10), 1 /* Async */, 1 /* Async */);
      }
    }
  }

  function isDesktopBrowserWin(win: number): boolean {
    return desktopBrowserHandles.hasOwnProperty(win);
  }

  function isFrameBrowserWin(win: number) {
    return frameBrowserFrameIdToWinId.hasOwnProperty(win);
  }

  function getFrameIdFromWindowId(wid: number): number | undefined {
    return frameBrowserWinIdToFrameId[wid];
  }

  function getWindowIdFromFrameId(wid: number): number | undefined {
    return frameBrowserFrameIdToWinId[wid];
  }

  function getRootIdFromWindowId(wid: number): number | undefined {
    return winIdToRootId[wid];
  }

  function createDesktopBrowser(props: { width: number; height: number }) {
    const win = new BrowserWindow({
      frame: false,
      fullscreen: true,
      width: props.width,
      height: props.height,
      type: "desktop",
      webPreferences: {
        preload: path.resolve(path.join(__dirname, "../renderer-shared/preload.js")),
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const index = desktopBrowsers.length;
    desktopBrowsers[index] = win;

    const url = path.join(__dirname, "../renderer-desktop/index.html") + "?screen=" + index;
    win.loadURL("file://" + url);

    const handle = getNativeWindowHandleInt(win);
    if (!handle) {
      logError("Browser handle was null");
    }
    desktopBrowserHandles[handle] = index;

    log("Created browser window", handle);

    win.on("closed", function () {
      desktopBrowsers[index] = null;
    });

    return handle;
  }

  function createFrameBrowser(wid: number, geometry: Geometry) {
    const win = new BrowserWindow({
      frame: false,
      width: geometry.width,
      height: geometry.height,
      x: geometry.x,
      y: geometry.y,
      webPreferences: {
        preload: path.resolve(path.join(__dirname, "../renderer-shared/preload.js")),
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const url = path.join(__dirname, "../renderer-frame/index.html") + "?wid=" + wid;
    win.loadURL("file://" + url);

    frameBrowserWindows[wid] = win;

    const fid = getNativeWindowHandleInt(win);
    if (!fid) {
      logError("Frame window handle was null");
    }
    frameBrowserWinIdToFrameId[wid] = fid;
    frameBrowserFrameIdToWinId[fid] = wid;

    log("Created frame window", fid, url);

    return fid;
  }

  function __onXEvent(ev: IXEvent) {
    const { type } = ev;

    switch (type) {
      case X11_EVENT_TYPE.KeyPress:
        onKeyPress(ev as IXKeyEvent);
        break;
      case X11_EVENT_TYPE.KeyRelease:
        break;
      case X11_EVENT_TYPE.ButtonPress:
        onButtonPress(ev);
        break;
      case X11_EVENT_TYPE.MotionNotify:
        break;
      case X11_EVENT_TYPE.EnterNotify:
        onEnterNotify(ev);
        break;
      case X11_EVENT_TYPE.LeaveNotify:
        onLeaveNotify(ev);
        break;
      case X11_EVENT_TYPE.FocusIn:
        widLog(ev.wid, "onFocusIn", ev);
        break;
      case X11_EVENT_TYPE.FocusOut:
        widLog(ev.wid, "onFocusOut", ev);
        break;
      case X11_EVENT_TYPE.Expose:
        widLog(ev.wid, "onExpose", ev);
        break;
      case X11_EVENT_TYPE.CreateNotify:
        onCreateNotify(ev);
        break;
      case X11_EVENT_TYPE.DestroyNotify:
        onDestroyNotify(ev);
        break;
      case X11_EVENT_TYPE.UnmapNotify:
        onUnmapNotify(ev);
        break;
      case X11_EVENT_TYPE.MapNotify:
        onMapNotify(ev);
        break;
      case X11_EVENT_TYPE.MapRequest:
        onMapRequest(ev);
        break;
      case X11_EVENT_TYPE.ReparentNotify:
        widLog(ev.wid, "onReparentNotify", ev);
        break;
      case X11_EVENT_TYPE.ConfigureNotify:
        break;
      case X11_EVENT_TYPE.ConfigureRequest:
        onConfigureRequest(ev as IXConfigureEvent);
        break;
      case X11_EVENT_TYPE.ClientMessage:
        onClientMessage(ev);
        break;
      case X11_EVENT_TYPE.PropertyNotify:
        onPropertyNotify(ev as IXPropertyNotifyEvent);
        break;
      default:
        log("Unhandled event", ev);
        break;
    }
  }

  async function manageWindow(wid: number, screenIndex: number, checkUnmappedState: boolean): Promise<void> {
    widLog(wid, `Manage window on screen ${screenIndex}`);

    if (initializingWins[wid]) {
      log(`Skip manage, ${wid} is already initializing`);
      return;
    }
    if (knownWids.has(wid)) {
      log(`Skip manage, ${wid} is known`);
      return;
    }
    if (isFrameBrowserWin(wid)) {
      log(`Skip manage, ${wid} is a frame window`);
      return;
    }

    // Make sure we don't respond to too many messages at once.
    initializingWins[wid] = true;
    knownWids.add(wid);

    const values = await Promise.all([
      determineWindowAttributes(wid),
      determineWindowGeometry(wid),
      getWindowTitle(wid),
      determineWindowDecorated(wid),
      getNormalHints(X, wid),
    ]);

    const [attrs, clientGeom, title, decorated, normalHints] = values;
    log(`got values for ${wid}:`, values);

    const isOverrideRedirect = attrs.overrideRedirect === 1;
    if (isOverrideRedirect) {
      log(`Not managing ${wid} due to override redirect.`);
    }

    const isUnmappedState = checkUnmappedState && attrs.mapState === XMapState.IsUnmapped;
    if (isUnmappedState) {
      log(`Not managing ${wid} due to unmapped state.`);
    }

    if (isOverrideRedirect || isUnmappedState) {
      delete initializingWins[wid];
      X.MapWindow(wid);
      return;
    }

    X.ChangeSaveSet(1, wid);

    if (shouldCreateFrame(wid, clientGeom)) {
      const effectiveGeometry = getGeometryForWindow(clientGeom);

      const fid = createFrameBrowser(wid, effectiveGeometry);
      knownWids.add(fid);

      const state = store.getState();
      const screen = state.screens[screenIndex];

      winIdToRootId[wid] = screen.root;
      winIdToRootId[fid] = screen.root;

      X.ReparentWindow(fid, screen.root, screen.x + effectiveGeometry.x, screen.y + effectiveGeometry.y);
      X.ReparentWindow(wid, fid, 0, 0);

      X.GrabServer();

      changeWindowEventMask(fid, FRAME_WIN_EVENT_MASK);
      changeWindowEventMask(wid, CLIENT_WIN_EVENT_MASK);

      X.UngrabServer();

      X.ConfigureWindow(fid, {
        borderWidth: 0,
      });
      X.ConfigureWindow(wid, {
        borderWidth: 0,
      });

      store.dispatch(
        actions.addWindow(wid, {
          outer: {
            x: effectiveGeometry.x,
            y: effectiveGeometry.y,
            width: effectiveGeometry.width,
            height: effectiveGeometry.height,
          },
          visible: true,
          decorated,
          title,
          screenIndex,
          tags: [screen.currentTags[0]],
          normalHints,
        })
      );

      X.MapWindow(fid);
    }

    log("Initial map of wid", wid);
    X.MapWindow(wid);

    delete initializingWins[wid];
  }

  function unmanageWindow(wid: number): void {
    if (isFrameBrowserWin(wid)) {
      widLog(wid, `Unmanage frame window`);

      const innerWid = frameBrowserFrameIdToWinId[wid];
      delete frameBrowserFrameIdToWinId[wid];
      delete frameBrowserWinIdToFrameId[innerWid];
      delete frameBrowserWindows[innerWid];
    } else if (isClientWin(wid)) {
      widLog(wid, `Unmanage window`);

      if (store.getState().windows.hasOwnProperty(wid)) {
        store.dispatch(actions.removeWindow(wid));
      }

      const fid = getFrameIdFromWindowId(wid);
      if (typeof fid === "number" && fid !== wid) {
        log("Destroying BrowserWindow for frame " + fid);
        frameBrowserWindows[wid].destroy();
      }
    }

    knownWids.delete(wid);
    delete winIdToRootId[wid];
  }

  function shouldCreateFrame(wid: number, geometry: XGeometry): boolean {
    if (isDesktopBrowserWin(wid)) {
      return false;
    }

    // Positioned negatively outside the desktop.
    if (geometry.xPos + geometry.width < 0 || geometry.yPos + geometry.height < 0) {
      return false;
    }

    // TODO: Positioned positively outside?

    return true;
  }

  function getGeometryForWindow(clientGeom: XGeometry): Geometry {
    return {
      height: clientGeom.height,
      width: clientGeom.width,
      x: clientGeom.xPos,
      y: clientGeom.yPos,
    };
  }

  function changeWindowEventMask(wid: number, eventMask: XEventMask): boolean {
    let failed;
    log("Changing event mask for", wid, eventMask);
    X.ChangeWindowAttributes(wid, { eventMask }, (err: { error: number }) => {
      if (err && err.error === 10) {
        logError(
          `Error while changing event mask for for ${wid} to ${eventMask}: Another window manager already running.`,
          err
        );
        failed = true;
        return;
      }
      logError(`Error while changing event mask for for ${wid} to ${eventMask}`, err);
      failed = true;
    });
    return !failed;
  }

  function runXCallsWithoutEvents(wid: number, fn: VoidFunction): void {
    X.GrabServer();
    try {
      const root = getRootIdFromWindowId(wid);
      if (typeof root === "number") {
        changeWindowEventMask(root, NO_EVENT_MASK);
      }
      const fid = getFrameIdFromWindowId(wid);
      if (typeof fid === "number") {
        changeWindowEventMask(fid, NO_EVENT_MASK);
      }
      changeWindowEventMask(wid, NO_EVENT_MASK);

      try {
        fn();
      } finally {
        if (typeof root === "number") {
          changeWindowEventMask(root, ROOT_WIN_EVENT_MASK);
        }
        if (typeof fid === "number") {
          changeWindowEventMask(fid, FRAME_WIN_EVENT_MASK);
        }
        changeWindowEventMask(wid, CLIENT_WIN_EVENT_MASK);
      }
    } finally {
      X.UngrabServer();
    }
  }

  function onCreateNotify(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onCreateNotify", ev);
  }

  async function onMapRequest(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onMapRequest", ev);

    if (initializingWins[wid]) return;

    if (knownWids.has(wid)) {
      showWindow(wid);
    } else {
      const screenIndex = Math.max(0, await getScreenIndexWithCursor(context, wid));
      manageWindow(wid, screenIndex, false);
    }
  }

  function onMapNotify(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onMapNotify", ev);

    if (isClientWin(wid)) {
      eventConsumers.forEach((consumer) => consumer.onMapNotify({ wid, windowType: getWindowType(wid) }));
    }
  }

  function onUnmapNotify(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onUnmapNotify", ev);

    eventConsumers.forEach((consumer) => consumer.onUnmapNotify({ wid, windowType: getWindowType(wid) }));

    unmanageWindow(wid);
  }

  function onDestroyNotify(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onDestroyNotify", ev);

    unmanageWindow(wid);
  }

  function onConfigureRequest(ev: IXConfigureEvent) {
    const { wid } = ev;
    widLog(wid, "onConfigureRequest", ev);
    if (isDesktopBrowserWin(wid)) {
      return;
    }

    // TODO: Let through any unmanaged windows?
    // TODO: Deny for frames too?
    return;

    const config = {
      x: ev.x,
      y: ev.y,
      width: ev.width,
      height: ev.height,
      //borderWidth: 0, // No borders
      //sibling: ev.sibling,
      //stackMode: ev.stackMode
    };
    const innerConfig = Object.assign({}, config, { x: 5, y: 10 });

    const isFrame = isFrameBrowserWin(ev.wid);
    if (isFrame) {
      //frameBrowserWindows[ev.wid].setPos
      // X.ConfigureWindow(frames[ev.wid], config);
    } else {
      X.ConfigureWindow(getFrameIdFromWindowId(ev.wid), config);
      X.ConfigureWindow(ev.wid, innerConfig);
    }

    store.dispatch(actions.configureWindow(ev.wid, config));
  }

  function onEnterNotify(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onEnterNotify");

    const isFrame = isFrameBrowserWin(wid);
    const window = isFrame ? getWindowIdFromFrameId(wid) : wid;

    changeFocus(window);
  }

  function changeFocus(wid: number) {
    if (isClientWin(wid)) {
      store.dispatch(actions.focusWindow(wid));
    }
  }

  function onLeaveNotify(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onLeaveNotify");
    // if (!isBrowserWin(ev.wid)) {
    //   const isFrame = !!frames[ev.wid];
    //   let window = isFrame ? frames[ev.wid] : ev.wid;
    //   store.dispatch(actions.unfocusWindow(window));
    // }
  }

  async function onKeyPress(ev: IXKeyEvent) {
    const { wid } = ev;
    widLog(wid, "onKeyPress", ev);

    const kb = registeredKeys;
    if (kb[ev.buttons]) {
      const entry = kb[ev.buttons][ev.keycode];
      if (typeof entry === "function") {
        entry();
      } else if (typeof entry === "boolean") {
        const screenIndex = await getScreenIndexWithCursor(context, wid);
        const browser = desktopBrowsers[screenIndex];
        if (browser) {
          browser.webContents.send("x-keypress", {
            buttons: ev.buttons,
            keycode: ev.keycode,
          });
        }
      }
    }
  }

  function onButtonPress(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onButtonPress", ev);

    if (isDesktopBrowserWin(ev.wid)) return;
    // X.RaiseWindow(ev.wid);
  }

  function onClientMessage(ev: IXEvent) {
    const { wid } = ev;
    widLog(wid, "onClientMessage", ev);

    // ClientMessage
    // minimize
    // { type: 33,
    //   seq: 60,
    //   name: 'ClientMessage',
    //   format: 32,
    //   wid: 14680072,
    //   message_type: 468,
    //   data: [ 3, 0, 0, 0, 0 ],
    //   rawData: <Buffer a1 20 3c 00 08 00 e0 00 d4 01 00 00 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00> }
  }

  async function onPropertyNotify(ev: IXPropertyNotifyEvent): Promise<void> {
    const { wid, atom } = ev;
    widLog(wid, "onPropertyNotify", ev);

    if (isFrameBrowserWin(wid) || isDesktopBrowserWin(wid)) {
      return;
    }

    switch (atom) {
      case X.atoms.WM_NAME:
      case ExtraAtoms._NET_WM_NAME:
        {
          const newTitle = await getWindowTitle(wid);
          store.dispatch(actions.setWindowTitle(wid, newTitle));
        }
        break;

      default:
        X.GetAtomName(atom, (err, name) => console.info(`Atom ${atom} (${name}) for property change is unhandled.`));
        break;
    }
  }

  function launchProcess(name: string) {
    log("launchProcess", name);

    const child = spawn(name, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref(); // Allow electron to close before this child
  }

  function determineWindowAttributes(wid: number): Promise<XWindowAttrs> {
    return new Promise((resolve, reject) => {
      X.GetWindowAttributes(wid, function (err: unknown, attrs) {
        if (err) {
          logError("Couldn't GetWindowAttributes", wid, err);
          reject(err);
          return;
        }

        resolve(attrs);
      });
    });
  }

  function determineWindowGeometry(wid: number): Promise<XGeometry> {
    return new Promise((resolve, reject) => {
      X.GetGeometry(wid, function (err: unknown, clientGeom) {
        if (err) {
          logError("Couldn't read geometry", err);
          reject(err);
          return;
        }

        resolve(clientGeom);
      });
    });
  }

  async function getWindowTitle(wid: number): Promise<string | undefined> {
    const [name, utf8name] = await Promise.all([
      getPropertyValue<string>(X, wid, X.atoms.WM_NAME, X.atoms.STRING),
      getPropertyValue<string>(X, wid, ExtraAtoms._NET_WM_NAME, ExtraAtoms.UTF8_STRING),
    ]);

    return utf8name || name;
  }

  function determineWindowDecorated(wid: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      X.InternAtom(true, "_MOTIF_WM_HINTS", (err, atom) => {
        if (err) {
          logError("InternAtom _MOTIF_WM_HINTS error", err);
          reject(err);
          return;
        }

        X.GetProperty(0, wid, atom, 0, 0, 10000000, (err, prop) => {
          if (err) {
            logError("GetProperty _MOTIF_WM_HINTS error", err);
            reject(err);
            return;
          }

          const buffer = prop.data;
          if (buffer && buffer.length) {
            if (buffer[0] === 0x02) {
              // Specifying decorations
              if (buffer[2] === 0x00) {
                // No decorations
                resolve(false);
              }
            }
          }
          resolve(true);
        });
      });
    });
  }

  /**
   * By default, one screen means one screen geometry.
   * But if Xinerama is in play, we may have multiple logical screens
   * represented within a single screen.
   */
  function getScreenGeometries(screen: IXScreen): Promise<Geometry[]> {
    return new Promise((resolve) => {
      const defaultGeometry: Geometry = {
        x: 0,
        y: 0,
        width: screen.pixel_width,
        height: screen.pixel_height,
      };

      requireXinerama(XDisplay, (err, xinerama) => {
        if (!xinerama) {
          resolve([defaultGeometry]);
          return;
        }

        xinerama.IsActive((err, isActive) => {
          if (!isActive) {
            resolve([defaultGeometry]);
            return;
          }

          xinerama.QueryScreens((err, screenInfos) => {
            if (err || !screenInfos) {
              resolve([defaultGeometry]);
              return;
            }

            resolve(screenInfos);
          });
        });
      });
    });
  }

  function getFocusedWindowId(): number | null {
    const windows = store.getState().windows;
    for (const wid in windows) {
      if (windows[wid].focused) return parseInt(wid);
    }
    return null;
  }

  function XGetWMProtocols(wid: number, callback: XCbWithErr<[number[] | void]>) {
    X.GetProperty(0, wid, ExtraAtoms.WM_PROTOCOLS, 0, 0, 10000000, (err, prop) => {
      if (err) {
        callback(err);
        return;
      }

      const protocols = [];
      if (prop && prop.data && prop.data.length) {
        const len = prop.data.length;
        if (len % 4) {
          callback("Bad length on WM protocol buffer");
          return;
        }

        for (let i = 0; i < len; i += 4) {
          protocols.push(prop.data.readUInt32LE(i));
        }
      }

      callback(null, protocols);
    });
  }

  function closeFocusedWindow(): void {
    const wid = getFocusedWindowId();
    if (typeof wid === "number" && !isDesktopBrowserWin(wid)) {
      closeWindow(wid);
    }
  }

  function closeWindow(wid: number) {
    supportsGracefulDestroy(wid, (err, args) => {
      if (err) {
        log("Error in supportsGracefulDestroy", err);
      }
      if (args && args.supported) {
        const eventData = Buffer.alloc(32);
        eventData.writeUInt8(X11_EVENT_TYPE.ClientMessage, 0); // Event Type 33 = ClientMessage
        eventData.writeUInt8(32, 1); // Format
        eventData.writeUInt32LE(wid, 4); // Window ID
        eventData.writeUInt32LE(ExtraAtoms.WM_PROTOCOLS, 8); // Message Type
        eventData.writeUInt32LE(ExtraAtoms.WM_DELETE_WINDOW, 12); // data32[0]
        // Also send a timestamp in data32[1]?
        widLog(wid, "Sending graceful kill", eventData);
        X.SendEvent(wid, false, XCB_EVENT_MASK_NO_EVENT, eventData);
      } else {
        widLog(wid, "Killing window client");
        X.KillClient(wid);
      }
    });
  }

  function supportsGracefulDestroy(wid: number, callback: XCbWithErr<[{ supported: boolean } | void]>) {
    XGetWMProtocols(wid, (err, protocols) => {
      if (err) {
        logError("XGetWMProtocols error", err);
        callback(err);
        return;
      }

      callback(null, {
        supported: !!protocols && protocols.indexOf(ExtraAtoms.WM_DELETE_WINDOW) >= 0,
      });
    });
  }

  function showWindow(wid: number) {
    let fid;
    const isFrame = isFrameBrowserWin(wid);
    if (isFrame) {
      fid = wid;
      wid = getWindowIdFromFrameId(wid);
    } else {
      fid = getFrameIdFromWindowId(wid);
    }

    if (typeof fid === "number") {
      log("showWindow frame id", fid);
      X.MapWindow(fid);
    }

    const win = getWinFromStore(wid);
    if (win?.visible === false) {
      store.dispatch(actions.setWindowVisible(wid, true));
    }

    log("showWindow id", wid);
    X.MapWindow(wid);
  }

  /** Hides a window without destroying its frame. */
  function hideWindow(wid: number) {
    const fid = getFrameIdFromWindowId(wid);

    runXCallsWithoutEvents(wid, () => {
      if (fid) {
        X.UnmapWindow(fid);
      }
      if (wid) {
        X.UnmapWindow(wid);
      }
    });

    const win = getWinFromStore(wid);
    if (win?.visible === true) {
      store.dispatch(actions.setWindowVisible(wid, false));
    }
  }

  function raiseWindow(wid: number) {
    const win = getWinFromStore(wid);

    if (!win.visible) {
      showWindow(wid);
    } else {
      const fid = getFrameIdFromWindowId(wid);
      if (fid) X.RaiseWindow(fid);
      if (wid) X.RaiseWindow(wid);
    }
  }

  function minimize(wid: number) {
    widLog(wid, "minimize");
    hideWindow(wid);
  }

  function sendActiveWindowToNextScreen(): void {
    const wid = getFocusedWindowId();
    const win = getWinFromStore(wid);
    if (win) {
      const screenCount = store.getState().screens.length;
      const nextScreen = (win.screenIndex + 1) % screenCount;
      store.dispatch(actions.setWindowIntoScreen(wid, nextScreen));
    }
  }

  function widLog(wid: number, ...args: unknown[]): void {
    const details = [];
    if (typeof wid === "number") {
      details.push(wid);

      switch (getWindowType(wid)) {
        case XWMWindowType.Frame:
          details.push(`(frame for ${getWindowIdFromFrameId(wid)})`);
          break;
        case XWMWindowType.Desktop:
          details.push("(desktop)");
          break;
      }
    }

    const logArgs = [...details, ...args];
    log(...logArgs);
  }

  function getWindowType(wid: number): XWMWindowType {
    if (isFrameBrowserWin(wid)) {
      return XWMWindowType.Frame;
    }
    if (isDesktopBrowserWin(wid)) {
      return XWMWindowType.Desktop;
    }
    if (isClientWin(wid)) {
      return XWMWindowType.Client;
    }

    return XWMWindowType.Other;
  }

  function isClientWin(wid: number): boolean {
    return !!getWinFromStore(wid);
  }

  function getWinFromStore(wid: number): IWindow | undefined {
    return store.getState().windows[wid];
  }

  function __setupStore(): ServerStore {
    const loggerMiddleware: Middleware = function ({ getState }) {
      return (next) => (action) => {
        log("will dispatch", action);

        // Call the next dispatch method in the middleware chain.
        const returnValue = next(action);

        log("state after dispatch:");
        logDir(getState(), { depth: 3 });

        // This will likely be the action itself, unless
        // a middleware further in chain changed it.
        return returnValue;
      };
    };

    const x11Middleware: Middleware<unknown, ServerRootState> = function ({ getState }) {
      return (next) => (action) => {
        const returnValue = next(action);

        switch (action.type) {
          case "CONFIGURE_WINDOW":
            {
              const state = getState();
              const wid = action.payload.wid;
              const win = state.windows[wid];
              const screen = state.screens[win.screenIndex];

              const fid = getFrameIdFromWindowId(wid) ?? wid;
              X.ConfigureWindow(fid, {
                x: screen.x + action.payload.x,
                y: screen.y + action.payload.y,
                width: action.payload.width,
                height: action.payload.height,
              });

              if (fid !== wid && win) {
                X.ConfigureWindow(wid, {
                  width: action.payload.width - win.inner.left - win.inner.right,
                  height: action.payload.height - win.inner.top - win.inner.bottom,
                });
              }
            }
            break;
          case "SET_WINDOW_FRAME_EXTENTS":
            {
              const state = getState();
              const wid = action.payload.wid;
              const win = state.windows[wid] as IWindow;
              const { width, height } = win.outer;
              X.ConfigureWindow(wid, {
                x: action.payload.left,
                y: action.payload.top,
                width: width - action.payload.left - action.payload.right,
                height: height - action.payload.top - action.payload.bottom,
              });

              eventConsumers.forEach((consumer) =>
                consumer.onSetFrameExtents?.({
                  wid,
                  frameExtents: {
                    left: action.payload.left,
                    right: action.payload.right,
                    top: action.payload.top,
                    bottom: action.payload.bottom,
                  },
                })
              );
            }
            break;
          case "SET_CURRENT_TAGS":
            {
              const state = getState();
              const { currentTags, screenIndex } = action.payload as {
                currentTags: string[];
                screenIndex: number;
              };
              batch(() => {
                for (const widStr in state.windows) {
                  const wid = parseInt(widStr, 10);
                  const win = state.windows[widStr];
                  if (win.screenIndex !== screenIndex) {
                    continue; // Other screens not affected.
                  }
                  if (anyIntersect(win.tags, currentTags)) {
                    showWindow(wid);
                  } else {
                    hideWindow(wid);
                  }
                }
              });
            }
            break;
        }

        return returnValue;
      };
    };

    const store = configureStore([loggerMiddleware, x11Middleware]);
    return store;
  }

  return server;
}

function getNativeWindowHandleInt(win: BrowserWindow): number {
  const hbuf = win.getNativeWindowHandle();
  return os.endianness() === "LE" ? hbuf.readInt32LE() : hbuf.readInt32BE();
}
