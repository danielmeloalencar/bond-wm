import { IXDisplay, X11_KEY_MODIFIER } from "../shared/X";
import { log, logError } from "./log";
import { IXWMEventConsumer, XWMContext, XWMEventConsumerKeyPressArgs } from "./wm";

const nodeKeySym = require("keysym"); // eslint-disable-line

export type KeyRegistrationMap = { [keyString: string]: (args: XWMEventConsumerKeyPressArgs) => void };

export interface ShortcutsModule extends IXWMEventConsumer {
  setupKeyShortcuts(rootWid: number, registeredKeys: KeyRegistrationMap): void;
}

export async function createShortcutsModule({ X, XDisplay }: XWMContext): Promise<ShortcutsModule> {
  const mapping = await getKeyboardMapping(XDisplay);

  // keycode -> [keysym no modifier, keysym with shift, keysym with AltGr (?), ...others]
  const keycodeToKeysyms: number[][] = [];
  const keysymsToKeycode: number[] = [];
  const keysymsToKeycodeShift: number[] = [];
  for (let i = 0; i < mapping.length; i++) {
    const keycode = XDisplay.min_keycode + i;
    const keysyms = mapping[i];
    keycodeToKeysyms[keycode] = keysyms;
    if (keysyms[0] > 0) {
      keysymsToKeycode[keysyms[0]] = keycode;
    }
    if (keysyms[1] > 0) {
      keysymsToKeycodeShift[keysyms[1]] = keycode;
    }
  }

  const processedRegisteredKeys: {
    [keyModifiers: number]: { [keyCode: number]: (args: XWMEventConsumerKeyPressArgs) => void };
  } = {};

  function getXModifierForShortcutPiece(piece: string): number | null {
    switch (piece.toLowerCase()) {
      case "shift":
        return X11_KEY_MODIFIER.ShiftMask;
      case "ctrl":
      case "ctl":
      case "control":
        return X11_KEY_MODIFIER.ControlMask;
      case "mod4":
      case "win":
        return X11_KEY_MODIFIER.Mod4Mask;
      default:
        return null;
    }
  }

  return {
    setupKeyShortcuts(rootWid: number, registeredKeys: KeyRegistrationMap): void {
      for (const keyString in registeredKeys) {
        const pieces = keyString
          .split("+")
          .map((s) => s.trim())
          .filter((s) => !!s);
        if (pieces.length === 0) {
          continue;
        }

        let xModifiers = 0;
        for (let i = 0; i < pieces.length - 1; i++) {
          const xModifier = getXModifierForShortcutPiece(pieces[i]);
          if (typeof xModifier === "number") {
            xModifiers |= xModifier;
          } else {
            logError("Unrecognized key modifier: " + pieces[i]);
          }
        }

        const lastPiece = pieces[pieces.length - 1];
        if (!lastPiece) {
          continue;
        }

        const keySym = nodeKeySym.fromName(lastPiece);
        const keySymMap = xModifiers & X11_KEY_MODIFIER.ShiftMask ? keysymsToKeycodeShift : keysymsToKeycode;
        const keycode = keySymMap[keySym.keysym];
        if (keycode > 0) {
          processedRegisteredKeys[xModifiers] ||= {};
          processedRegisteredKeys[xModifiers][keycode] = registeredKeys[keyString];
          X.GrabKey(rootWid, true, xModifiers, keycode, 1 /* Async */, 1 /* Async */);
          log(`Registered modifiers: ${xModifiers}, keycode: ${keycode} for ${keyString}`);
        } else {
          logError("Could not register " + keyString);
        }
      }
    },

    onKeyPress(args) {
      const { keycode, modifiers } = args;
      const keysyms = keycodeToKeysyms[keycode];
      log("keysyms", keysyms);
      if (keysyms) {
        const keysym = keysyms[modifiers & X11_KEY_MODIFIER.ShiftMask ? 1 : 0];
        if (keysym) {
          log("keysym", keysym);
          log("fromKeysym", nodeKeySym.fromKeysym(keysym));
        }
      }

      if (processedRegisteredKeys[args.modifiers]) {
        const entry = processedRegisteredKeys[args.modifiers][args.keycode];
        if (typeof entry === "function") {
          log("Running shortcut handler");
          entry(args);
          return true;
        }
      }

      return false;
    },
  };
}

async function getKeyboardMapping(XDisplay: IXDisplay): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const { min_keycode, max_keycode } = XDisplay;
    XDisplay.client.GetKeyboardMapping(min_keycode, max_keycode - min_keycode, (err, list) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(list);
    });
  });
}