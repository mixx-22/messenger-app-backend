const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const {
  createGroup,
  deleteGroup,
  leaveGroup,
  listGroups,
  updateGroupDetails,
  updateGroupMembers,
} = require('../controllers/groupController');

router.get('/', auth, listGroups);
router.post('/', auth, createGroup);
router.patch('/:id', auth, updateGroupDetails);
router.patch('/:id/members', auth, updateGroupMembers);
router.post('/:id/leave', auth, leaveGroup);
router.delete('/:id', auth, deleteGroup);

module.exports = router;
