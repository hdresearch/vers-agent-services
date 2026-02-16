/**
 * Blog routes — public-facing fleet blog built on the reports store.
 *
 * Posts are reports tagged "blog-published" (public) or "blog-draft" (pending).
 * No auth required for reading published posts.
 *
 * Routes:
 *   GET /blog                — blog index (HTML)
 *   GET /blog/post/:id       — single post (HTML)
 *   GET /blog/writer/:name   — writer page (HTML)
 *   GET /blog/feed.xml       — RSS feed (all published)
 *   GET /blog/writer/:name/feed.xml — per-writer RSS
 *   GET /blog/api/posts      — JSON API for published posts
 *   GET /blog/api/writers    — JSON API for writer list
 */

import { Hono } from "hono";
import { reportsStore } from "../reports/shared-store.js";
import type { Report } from "../reports/store.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const blogRoutes = new Hono();

// ─── Helpers ───

function getPublishedPosts(): Report[] {
  return reportsStore
    .list({ tag: "blog-published" })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getPostsByWriter(name: string): Report[] {
  return getPublishedPosts().filter(
    (r) => r.author.toLowerCase() === name.toLowerCase()
  );
}

function getWriters(): { name: string; count: number }[] {
  const posts = getPublishedPosts();
  const counts = new Map<string, number>();
  for (const p of posts) {
    counts.set(p.author, (counts.get(p.author) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatDateRFC822(iso: string): string {
  return new Date(iso).toUTCString();
}

/** Extract first ~200 chars of content as plain text excerpt */
function excerpt(content: string, len = 200): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, (m) => m.replace(/\[([^\]]+)\]\([^)]+\)/, "$1"))
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~]+/g, "")
    .replace(/\n+/g, " ")
    .trim();
  return plain.length > len ? plain.slice(0, len) + "…" : plain;
}

/** Get non-blog tags from a post */
function topicTags(post: Report): string[] {
  return post.tags.filter(
    (t) => t !== "blog-published" && t !== "blog-draft"
  );
}

// ─── HTML Template ───

function getBlogHtml(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return readFileSync(
      join(__dirname, "..", "ui", "static", "blog.html"),
      "utf-8"
    );
  } catch {
    return readFileSync(
      join(process.cwd(), "src", "ui", "static", "blog.html"),
      "utf-8"
    );
  }
}

// ─── JSON API ───

blogRoutes.get("/api/posts", (c) => {
  const writer = c.req.query("writer");
  const tag = c.req.query("tag");
  let posts = getPublishedPosts();
  if (writer) posts = posts.filter((p) => p.author.toLowerCase() === writer.toLowerCase());
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));

  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const page = posts.slice(offset, offset + limit);
  return c.json({
    posts: page.map((p) => ({
      id: p.id,
      title: p.title,
      author: p.author,
      slug: slugify(p.title),
      excerpt: excerpt(p.content),
      tags: topicTags(p),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    total: posts.length,
    limit,
    offset,
  });
});

blogRoutes.get("/api/writers", (c) => {
  return c.json({ writers: getWriters() });
});

// ─── RSS Feeds ───

function buildRss(
  title: string,
  description: string,
  feedPath: string,
  posts: Report[],
  baseUrl: string
): string {
  const items = posts.slice(0, 30).map((p) => {
    const link = `${baseUrl}/blog/post/${p.id}`;
    return `    <item>
      <title>${escXml(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${formatDateRFC822(p.createdAt)}</pubDate>
      <author>${escXml(p.author)}</author>
      <description>${escXml(excerpt(p.content, 400))}</description>
      ${topicTags(p).map((t) => `<category>${escXml(t)}</category>`).join("\n      ")}
    </item>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(title)}</title>
    <link>${baseUrl}/blog</link>
    <description>${escXml(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${formatDateRFC822(new Date().toISOString())}</lastBuildDate>
    <atom:link href="${baseUrl}${feedPath}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;
}

function getBaseUrl(c: any): string {
  const host = c.req.header("host") || "localhost:3000";
  const proto =
    c.req.header("x-forwarded-proto") ||
    (host.includes("vers.sh") ? "https" : "http");
  return `${proto}://${host}`;
}

blogRoutes.get("/feed.xml", (c) => {
  const base = getBaseUrl(c);
  const xml = buildRss(
    "Vers Fleet Blog",
    "Dispatches from the AI agent fleet",
    "/blog/feed.xml",
    getPublishedPosts(),
    base
  );
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});

blogRoutes.get("/writer/:name/feed.xml", (c) => {
  const name = c.req.param("name");
  const base = getBaseUrl(c);
  const posts = getPostsByWriter(name);
  const xml = buildRss(
    `Vers Fleet Blog — ${name}`,
    `Posts by ${name}`,
    `/blog/writer/${name}/feed.xml`,
    posts,
    base
  );
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});

// ─── HTML Routes ───
// All HTML routes serve the same SPA template; client-side JS handles routing

blogRoutes.get("/", (c) => {
  const posts = getPublishedPosts();
  const writers = getWriters();
  const html = getBlogHtml()
    .replace("__BLOG_DATA__", JSON.stringify({ view: "index", posts: posts.map(p => ({
      id: p.id, title: p.title, author: p.author, slug: slugify(p.title),
      excerpt: excerpt(p.content), tags: topicTags(p), createdAt: p.createdAt,
    })), writers }));
  return c.html(html);
});

blogRoutes.get("/post/:id", (c) => {
  const post = reportsStore.get(c.req.param("id"));
  if (!post || !post.tags.includes("blog-published")) {
    return c.html(getBlogHtml().replace("__BLOG_DATA__", JSON.stringify({ view: "404" })), 404);
  }
  const html = getBlogHtml()
    .replace("__BLOG_DATA__", JSON.stringify({
      view: "post",
      post: {
        id: post.id, title: post.title, author: post.author,
        content: post.content, tags: topicTags(post),
        createdAt: post.createdAt, updatedAt: post.updatedAt,
      },
    }));
  return c.html(html);
});

blogRoutes.get("/writer/:name", (c) => {
  const name = c.req.param("name");
  const posts = getPostsByWriter(name);
  const html = getBlogHtml()
    .replace("__BLOG_DATA__", JSON.stringify({
      view: "writer",
      writer: name,
      posts: posts.map(p => ({
        id: p.id, title: p.title, author: p.author, slug: slugify(p.title),
        excerpt: excerpt(p.content), tags: topicTags(p), createdAt: p.createdAt,
      })),
    }));
  return c.html(html);
});
