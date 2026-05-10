import { describe, expect, it } from "vitest";
import { Fragment, h, jsx, raw, renderToDocument, renderToString } from "../src/jsx.js";

describe("JSX Runtime", () => {
  // ─── h() factory ───

  it("should create a VNode from h()", () => {
    const node = h("div", { class: "test" }, "Hello");
    expect(node.type).toBe("div");
    expect(node.props).toEqual({ class: "test" });
    expect(node.children).toEqual(["Hello"]);
  });

  it("should handle null props", () => {
    const node = h("span", null, "text");
    expect(node.props).toEqual({});
  });

  // ─── renderToString ───

  it("should render a simple element", () => {
    const html = renderToString(h("div", null, "Hello"));
    expect(html).toBe("<div>Hello</div>");
  });

  it("should render nested elements", () => {
    const html = renderToString(h("div", null, h("span", null, "nested")));
    expect(html).toBe("<div><span>nested</span></div>");
  });

  it("should render attributes", () => {
    const html = renderToString(h("a", { href: "/test", class: "link" }, "Click"));
    expect(html).toBe('<a href="/test" class="link">Click</a>');
  });

  it("should escape HTML in text content", () => {
    const html = renderToString(h("div", null, '<script>alert("xss")</script>'));
    expect(html).toBe("<div>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>");
  });

  it("should escape HTML in attribute values", () => {
    const html = renderToString(h("div", { title: '"><script>' }, "test"));
    expect(html).toBe('<div title="&quot;&gt;&lt;script&gt;">test</div>');
  });

  it("should render boolean attributes", () => {
    const html = renderToString(h("input", { type: "checkbox", checked: true, disabled: false }));
    expect(html).toBe('<input type="checkbox" checked />');
  });

  it("should render void (self-closing) elements", () => {
    const html = renderToString(h("br", null));
    expect(html).toBe("<br />");
    const html2 = renderToString(h("img", { src: "/logo.png", alt: "logo" }));
    expect(html2).toBe('<img src="/logo.png" alt="logo" />');
  });

  it("should render number children", () => {
    const html = renderToString(h("span", null, 42));
    expect(html).toBe("<span>42</span>");
  });

  it("should skip null, undefined, and boolean children", () => {
    const html = renderToString(h("div", null, null, undefined, true, false, "visible"));
    expect(html).toBe("<div>visible</div>");
  });

  it("should render array children", () => {
    const items = ["a", "b", "c"];
    const html = renderToString(h("ul", null, ...items.map((i) => h("li", null, i))));
    expect(html).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
  });

  it("should convert className to class", () => {
    const html = renderToString(h("div", { className: "container" }, "test"));
    expect(html).toBe('<div class="container">test</div>');
  });

  it("should convert htmlFor to for", () => {
    const html = renderToString(h("label", { htmlFor: "name" }, "Name"));
    expect(html).toBe('<label for="name">Name</label>');
  });

  it("should render style objects", () => {
    const html = renderToString(h("div", { style: { color: "red", fontSize: "14px" } }, "styled"));
    expect(html).toBe('<div style="color:red;font-size:14px">styled</div>');
  });

  // ─── Fragment ───

  it("should render fragments without wrapper", () => {
    const html = renderToString(h(Fragment, null, h("span", null, "a"), h("span", null, "b")));
    expect(html).toBe("<span>a</span><span>b</span>");
  });

  // ─── Function components ───

  it("should render function components", () => {
    function Greeting(props: { name: string }) {
      return h("h1", null, `Hello, ${props.name}!`);
    }
    const html = renderToString(h(Greeting as any, { name: "World" }));
    expect(html).toBe("<h1>Hello, World!</h1>");
  });

  it("should render function components with children", () => {
    function Card(props: { children: unknown[] }) {
      return h("div", { class: "card" }, ...(props.children as any[]));
    }
    const html = renderToString(h(Card as any, null, h("p", null, "Content")));
    expect(html).toBe('<div class="card"><p>Content</p></div>');
  });

  // ─── dangerouslySetInnerHTML ───

  it("should support dangerouslySetInnerHTML", () => {
    const html = renderToString(h("div", { dangerouslySetInnerHTML: { __html: "<b>bold</b>" } }));
    expect(html).toBe("<div><b>bold</b></div>");
  });

  // ─── raw() helper ───

  it("should insert raw HTML via raw()", () => {
    const html = renderToString(h("div", null, raw("<em>raw</em>")));
    expect(html).toBe("<div><span><em>raw</em></span></div>");
  });

  // ─── renderToDocument ───

  it("should render a full HTML document", () => {
    const html = renderToDocument(h("html", null, h("body", null, "Hello")));
    expect(html).toBe("<!DOCTYPE html><html><body>Hello</body></html>");
  });

  // ─── jsx() runtime function ───

  it("should work with jsx() automatic runtime format", () => {
    const node = jsx("div", { class: "auto", children: "Hello" });
    expect(node.type).toBe("div");
    expect(node.props).toEqual({ class: "auto" });
    expect(node.children).toEqual(["Hello"]);
  });

  it("should handle jsx() with array children", () => {
    const node = jsx("ul", { children: [jsx("li", { children: "a" }), jsx("li", { children: "b" })] });
    const html = renderToString(node);
    expect(html).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  // ─── Integration with CelsianReply ───

  it("should work with reply.html() pattern", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp({ security: false });

    app.get("/page", (_req, reply) => {
      const page = h(
        "html",
        null,
        h("head", null, h("title", null, "Test")),
        h("body", null, h("h1", null, "Hello from JSX")),
      );
      return reply.html(renderToDocument(page));
    });

    const res = await app.inject({ url: "/page" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("<h1>Hello from JSX</h1>");
  });
});
