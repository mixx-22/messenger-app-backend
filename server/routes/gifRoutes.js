const router = require("express").Router();
const fs = require("fs/promises");
const path = require("path");
const auth = require("../middleware/authMiddleware");

const gifDir = path.resolve(process.env.GIFS_DIR || "");
const GIF_EXTENSIONS = new Set([".gif", ".webp"]);

function isGifConfigured() {
  return Boolean(process.env.GIFS_DIR && process.env.GIFS_DIR.trim());
}

function gifFilePath(name) {
  const safeName = path.basename(String(name || ""));
  if (!safeName || !GIF_EXTENSIONS.has(path.extname(safeName).toLowerCase())) {
    return "";
  }
  return path.join(gifDir, safeName);
}

router.get("/file/:name", (req, res, next) => {
  if (!isGifConfigured()) {
    return res.status(404).end();
  }

  const filePath = gifFilePath(req.params.name);
  if (!filePath) {
    return res.status(404).end();
  }

  return res.sendFile(filePath, (err) => {
    if (err) next(err);
  });
});

router.get("/", auth, async (req, res, next) => {
  try {
    if (!isGifConfigured()) {
      return res.json({ items: [] });
    }

    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 80, 1),
      200,
    );

    const entries = await fs.readdir(gifDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => GIF_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .filter((name) => !q || name.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .slice(0, limit);

    const items = await Promise.all(
      files.map(async (name) => {
        const stat = await fs.stat(path.join(gifDir, name));
        const ext = path.extname(name).toLowerCase();
        return {
          fileName: name,
          originalName: name,
          url: `/api/gifs/file/${encodeURIComponent(name)}`,
          mimetype: ext === ".webp" ? "image/webp" : "image/gif",
          type: "image",
          size: stat.size,
        };
      }),
    );

    return res.json({ items });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return res.json({ items: [] });
    }
    next(err);
  }
});

module.exports = router;
