export type ContentSizeSource = 'content' | 'user-resize' | 'programmatic-resize';

export interface ContentSizeInfo {
  /** Why this event fired. */
  source: ContentSizeSource;
  /** True while the user is actively dragging the window edges. */
  userResizing: boolean;
  /** Measured content width in CSS px. */
  contentWidth: number;
  /** Measured content height in CSS px. */
  contentHeight: number;
  /** Window inner width in CSS px (`window.innerWidth`). */
  windowWidth: number;
  /** Window inner height in CSS px (`window.innerHeight`). */
  windowHeight: number;
  /** Layout viewport width (`documentElement.clientWidth`); excludes vertical scrollbar. */
  viewportWidth: number;
  /** Layout viewport height (`documentElement.clientHeight`); excludes horizontal scrollbar. */
  viewportHeight: number;
  /** True when a vertical scrollbar is currently consuming layout space. */
  verticalScrollbar: boolean;
  /** Width in CSS px taken by the vertical scrollbar (0 if none / overlay). */
  verticalScrollbarSize: number;
  /** True when a horizontal scrollbar is currently consuming layout space. */
  horizontalScrollbar: boolean;
  /** Height in CSS px taken by the horizontal scrollbar (0 if none / overlay). */
  horizontalScrollbarSize: number;
  /** `window.devicePixelRatio` at the moment of measurement. */
  devicePixelRatio: number;
}

export interface ContentSizeOptions {
  /** Which axes to report. Default: `'both'`. */
  axes?: 'both' | 'width' | 'height';
  /**
   * CSS `scrollbar-gutter` applied to the page root to keep layout stable
   * regardless of scrollbar visibility. Default: `'stable'`.
   */
  scrollbarGutter?: 'auto' | 'stable' | 'stable-both';
  /** When true, the reported size never decreases. Default: `false`. */
  growOnly?: boolean;
  /** When true, the reported size never increases. Default: `false`. */
  shrinkOnly?: boolean;
  /** Ignore changes smaller than this many CSS px on each axis. Default: `1`. */
  minDelta?: number;
  /** Debounce in ms for the JS observer. `0` uses a single requestAnimationFrame. Default: `0`. */
  debounceMs?: number;
  /** Include body margin in reported content size. Default: `true`. */
  includeBodyMargin?: boolean;
  /** Suppression window after a window resize during which content events are deferred. Default: `300`. */
  suppressDuringResizeMs?: number;
  /** Emit a synthetic `'user-resize'` event when the user finishes resizing the window. Default: `true`. */
  emitOnUserResize?: boolean;
  /** Emit a synthetic `'programmatic-resize'` event after `gui.resize()` settles. Default: `false`. */
  emitOnProgrammaticResize?: boolean;
}

/** Optional minimum/maximum dimensions for one rectangle. All fields optional. */
export interface SizeLimits {
  /** Minimum width in CSS px (inclusive). Omit to leave unconstrained. */
  minWidth?: number;
  /** Maximum width in CSS px (inclusive). Omit to leave unconstrained. */
  maxWidth?: number;
  /** Minimum height in CSS px (inclusive). Omit to leave unconstrained. */
  minHeight?: number;
  /** Maximum height in CSS px (inclusive). Omit to leave unconstrained. */
  maxHeight?: number;
}

export interface ResizeOptions {
  /**
   * Restrict which axes the user can resize.
   * - `'both'` (default): both width and height are resizable.
   * - `'widthOnly'`: height is locked at the initial value; only width can change.
   * - `'heightOnly'`: width is locked at the initial value; only height can change.
   */
  axis?: 'both' | 'widthOnly' | 'heightOnly';
  /** Constraints on the inner content area (CSS px, before scaling). */
  innerSize?: SizeLimits;
  /** Constraints on the outer window frame (includes title bar / borders). */
  outerSize?: SizeLimits;
}

export interface GuiOptions {
  /** Initial window width in pixels. */
  width: number;
  /** Initial window height in pixels. */
  height: number;
  /** Localhost port to navigate to (1–65535). */
  port: number;
  /** Callback invoked when the window is closed. */
  onClose?: () => void;
  /** Callback invoked when the content/window size or related state changes. */
  onSizeChanged?: (info: ContentSizeInfo) => void;
  /** Tuning options for the content-size observer. */
  contentSizeOptions?: ContentSizeOptions;
  /** Constraints applied while the user resizes the window. */
  resizeOptions?: ResizeOptions;
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
