// @celsian/core — JSX runtime for server-side HTML rendering
//
// Usage with TypeScript:
//   tsconfig.json: { "jsx": "react-jsx", "jsxImportSource": "@celsian/core" }
//
// Or classic mode:
//   tsconfig.json: { "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" }
//   import { h, Fragment } from '@celsian/core/jsx';

// ─── Types ───

export type Child = string | number | boolean | null | undefined | VNode | Child[];

export interface VNode {
  type: string | typeof Fragment | ((props: Record<string, unknown>) => VNode);
  props: Record<string, unknown>;
  children: Child[];
}

// Escape HTML to prevent XSS in rendered output
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]!);
}

// Void (self-closing) HTML elements
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// CSS property to kebab-case conversion
function toKebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

// ─── Fragment ───

/** Fragment component — renders children without a wrapper element. */
export const Fragment = Symbol.for("celsian.fragment");

// ─── h() factory ───

/**
 * Create a virtual DOM node. Used as the JSX factory function.
 *
 * @example
 * ```tsx
 * const page = <div class="container"><h1>Hello</h1></div>;
 * const html = renderToString(page);
 * return reply.html(html);
 * ```
 */
export function h(
  type: string | typeof Fragment | ((props: Record<string, unknown>) => VNode),
  props: Record<string, unknown> | null,
  ...children: Child[]
): VNode {
  return {
    type,
    props: props ?? {},
    children,
  };
}

// ─── jsx/jsxs runtime (for react-jsx transform) ───

export function jsx(
  type: string | typeof Fragment | ((props: Record<string, unknown>) => VNode),
  props: Record<string, unknown>,
): VNode {
  const { children, ...rest } = props;
  return {
    type,
    props: rest,
    children: children !== undefined ? (Array.isArray(children) ? children : [children]) : [],
  };
}

export { jsx as jsxs };

// ─── Render to String ───

function renderChild(child: Child): string {
  if (child === null || child === undefined || typeof child === "boolean") {
    return "";
  }
  if (typeof child === "string") {
    return escapeHtml(child);
  }
  if (typeof child === "number") {
    return String(child);
  }
  if (Array.isArray(child)) {
    return child.map(renderChild).join("");
  }
  return renderToString(child);
}

function renderProps(props: Record<string, unknown>): string {
  let result = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    if (value === false || value === null || value === undefined) continue;

    // Boolean attributes
    if (value === true) {
      result += ` ${key}`;
      continue;
    }

    // Style objects
    if (key === "style" && typeof value === "object") {
      const css = Object.entries(value as Record<string, string | number>)
        .map(([prop, val]) => `${toKebabCase(prop)}:${val}`)
        .join(";");
      result += ` style="${escapeHtml(css)}"`;
      continue;
    }

    // className -> class
    const attrName = key === "className" ? "class" : key === "htmlFor" ? "for" : key;

    // dangerouslySetInnerHTML handled separately
    if (key === "dangerouslySetInnerHTML") continue;

    result += ` ${attrName}="${escapeHtml(String(value))}"`;
  }
  return result;
}

/**
 * Render a VNode tree to an HTML string.
 *
 * @example
 * ```tsx
 * const vnode = <div><h1>Hello</h1></div>;
 * const html = renderToString(vnode);
 * // html === '<div><h1>Hello</h1></div>'
 * ```
 */
export function renderToString(node: VNode): string {
  // Fragment
  if (node.type === Fragment) {
    return node.children.map(renderChild).join("");
  }

  // Function component
  if (typeof node.type === "function") {
    const result = node.type({ ...node.props, children: node.children });
    return renderToString(result);
  }

  const tag = node.type as string;
  const attrs = renderProps(node.props);

  // Void elements (self-closing)
  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs} />`;
  }

  // dangerouslySetInnerHTML
  const dangerous = node.props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (dangerous) {
    return `<${tag}${attrs}>${dangerous.__html}</${tag}>`;
  }

  const childrenHtml = node.children.map(renderChild).join("");
  return `<${tag}${attrs}>${childrenHtml}</${tag}>`;
}

/**
 * Render a VNode tree to a full HTML document string (with <!DOCTYPE html>).
 */
export function renderToDocument(node: VNode): string {
  return `<!DOCTYPE html>${renderToString(node)}`;
}

/**
 * Create a raw HTML string that bypasses escaping.
 * Use with caution — only for trusted content.
 */
export function raw(html: string): VNode {
  return {
    type: "span",
    props: { dangerouslySetInnerHTML: { __html: html } },
    children: [],
  };
}
