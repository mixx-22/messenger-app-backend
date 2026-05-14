const router = require("express").Router();
const fs = require("fs");
const multer = require("multer");
const path = require("path");
const auth = require("../middleware/authMiddleware");
const appSettingService = require("../services/appSettingService");

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const getFileType = (mimetype) => {
  if (!mimetype || typeof mimetype !== "string") return "other";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype === "application/pdf") return "pdf";
  return "other";
};

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

router.post("/", auth, async (req, res, next) => {
  try {
    const limit = await appSettingService.getMaxAttachmentBytes();
    const upload = multer({
      storage,
      limits: { fileSize: limit },
      fileFilter: (_rq, file, cb) => {
        if (!allowedMimeTypes.has(file.mimetype)) {
          return cb(new Error("File type is not allowed"));
        }
        cb(null, true);
      },
    }).single("file");

    upload(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        const limitBytes = await appSettingService.getMaxAttachmentBytes();
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            message: `File too large. Maximum upload size is ${Math.round(limitBytes / (1024 * 1024))} MB.`,
          });
        }
        return res.status(400).json({ message: err.message || "Upload failed" });
      }
      if (err) {
        return res.status(400).json({ message: err.message || "Upload failed" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const file = req.file;

      const fileData = {
        fileName: file.filename,
        originalName: file.originalname,
        url: `/uploads/${file.filename}`,
        mimetype: file.mimetype,
        type: getFileType(file.mimetype),
        size: file.size,
      };

      return res.json(fileData);
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
