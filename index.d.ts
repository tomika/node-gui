export interface GuiOptions {
  /** Initial window width in pixels. */
  width: number;
  /** Initial window height in pixels. */
  height: number;
  /** Localhost port to navigate to (1–65535). */
  port: number;
  /** Callback invoked when the window is closed. */
  onClose?: () => void;
  /** Callback invoked with document content size in pixels. */
  onContentSizeChanged?: (width: number, height: number) => void;
}

export interface GuiHandle {
  /** Close the native window. Safe to call multiple times. */
  close(): void;
  /** Move window to screen coordinates. */
  move(left: number, top: number): void;
  /** Resize window by desired inner content dimensions. */
  resize(innerWidth: number, innerHeight: number): void;
}

export interface DisplayArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GuiHandleStatic {
  displayArea(): DisplayArea;
}

/**
 * Open a native window with an embedded browser control pointing to
 * `http://localhost:<port>`.
 */
export function open(options: GuiOptions): GuiHandle;

export const GuiHandle: GuiHandleStatic;
