import { RectangleMarker, type EditorView } from "@codemirror/view";

/** A layer marker spanning document heights `top`–`bottom`, outset 8px past the text column. */
export function blockRect(view: EditorView, className: string, top: number, bottom: number) {
  const scroller = view.scrollDOM.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  const style = getComputedStyle(view.contentDOM);
  const baseLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX;
  const baseTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY;
  const left = (content.left - baseLeft) / view.scaleX + parseFloat(style.paddingLeft);
  const right = (content.right - baseLeft) / view.scaleX - parseFloat(style.paddingRight);
  const offset = (view.documentTop - baseTop) / view.scaleY;
  return new RectangleMarker(
    className,
    left - 8,
    top + offset - 2,
    right - left + 16,
    bottom - top + 4,
  );
}
