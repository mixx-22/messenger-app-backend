const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const requireRole = require('../middleware/requireRole');
const {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  updateMyProfile,
  updateMyStatus,
  setUserSuspension,
  changeMyPassword,
  resetUserPassword,
  acceptMyTerms
} = require('../controllers/userController');

router.patch('/me', auth, updateMyProfile);
router.patch('/me/status', auth, updateMyStatus);
router.patch('/me/password', auth, changeMyPassword);
router.patch('/me/terms', auth, acceptMyTerms);
router.get('/', auth, listUsers);
router.post('/', auth, requireRole('Administrator'), createUser);
router.patch('/:id/suspension', auth, requireRole('Administrator'), setUserSuspension);
router.post('/:id/password-reset', auth, requireRole('Administrator'), resetUserPassword);
router.put('/:id', auth, requireRole('Administrator'), updateUser);
router.delete('/:id', auth, requireRole('Administrator'), deleteUser);

module.exports = router;
