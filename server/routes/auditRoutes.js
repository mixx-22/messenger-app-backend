const router = require("express").Router();
const auth = require("../middleware/authMiddleware");
const requireRole = require("../middleware/requireRole");
const { listAuditLogs } = require("../controllers/auditController");

router.get("/", auth, requireRole("Administrator"), listAuditLogs);

module.exports = router;
