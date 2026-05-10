// @celsian/core — JSX automatic runtime (react-jsx transform)
//
// TypeScript config:
//   { "jsx": "react-jsx", "jsxImportSource": "@celsian/core" }

export { Fragment, jsx, jsxs } from "./jsx.js";

export namespace JSX {
  export type Element = import("./jsx.js").VNode;
  export interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}
