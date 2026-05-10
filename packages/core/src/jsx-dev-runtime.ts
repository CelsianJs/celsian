// @celsian/core — JSX dev runtime (react-jsx transform, development mode)

export { Fragment, jsx, jsx as jsxDEV, jsxs } from "./jsx.js";

export namespace JSX {
  export type Element = import("./jsx.js").VNode;
  export interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}
