import * as React from "react";
import { ReactNode, useCallback, useEffect, useState } from "react";
import {
  configureRendererStore,
  showContextMenu,
  setupIpc,
  invokeDesktopShortcutHandler,
} from "@bond-wm/shared-renderer";
import { ContextMenuKind } from "@bond-wm/shared";
import { desktopZoomIn, desktopZoomOut, desktopZoomReset, showDevTools } from "@bond-wm/shared-renderer";
import { getScreenIndex, useScreenIndex } from "../useScreenIndex";
import { Provider } from "react-redux";
import "./DesktopStyles.css";

export interface IDesktopProps {
  children?: ReactNode;
}

export function Desktop({ children }: IDesktopProps) {
  const [store] = useState(() => configureRendererStore());

  const screenIndex = useScreenIndex();

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(ContextMenuKind.Desktop);
  }, []);

  useEffect(() => {
    (window as any).store = store; // eslint-disable-line
    setupIpc({
      onInvokeDesktopShortcutHandler(keyString) {
        invokeDesktopShortcutHandler(keyString, screenIndex);
      },
    });
    hookShortcuts(document.body);
  }, [store, screenIndex]);

  return (
    <Provider store={store}>
      <div id="desktop" onContextMenu={onContextMenu}>
        {children}
      </div>
    </Provider>
  );
}

function hookShortcuts(el: HTMLElement): void {
  el.addEventListener("keydown", onKeydown);
}

function onKeydown(e: KeyboardEvent): void {
  // No modifier + ...
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
    switch (e.key) {
      case "F12":
        showDevTools(getScreenIndex());
        break;
    }
  }

  // Ctrl + ...
  if (e.ctrlKey && !e.altKey && !e.shiftKey) {
    switch (e.key) {
      case "=": // + sign
        desktopZoomIn(getScreenIndex());
        break;

      case "-":
        desktopZoomOut(getScreenIndex());
        break;

      case "0":
        desktopZoomReset(getScreenIndex());
        break;
    }
  }
}
