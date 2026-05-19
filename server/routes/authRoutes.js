const router = require('express').Router();
const { register, login, restoreSession } = require('../controllers/authController');
const rateLimit = require('../middleware/rateLimit');

router.post('/register', rateLimit({ windowMs: 60_000, max: 10 }), register);
router.post('/login', rateLimit({ windowMs: 60_000, max: 8 }), login);
router.post('/restore', restoreSession);

module.exports = router;
