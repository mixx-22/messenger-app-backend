const router = require("express").Router();
const auth = require("../middleware/authMiddleware");
const requireRole = require("../middleware/requireRole");
const {
  getAttachmentSettings,
  putAttachmentSettings,
} = require("../controllers/settingsController");

router.get("/attachments", auth, getAttachmentSettings);
router.put(
  "/attachments",
  auth,
  requireRole("Administrator"),
  putAttachmentSettings
);

module.exports = router;
