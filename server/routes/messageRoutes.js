const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const requireRole = require('../middleware/requireRole');
const {
  sendMessage,
  getInbox,
  getSent,
  getUnreadBySender,
  getConversation,
  getAnnouncements,
  getGroupMessages,
  getChatAttachments,
  searchMessages,
  getFlaggedMessages,
  deleteMessage,
  editMessage,
  reactToMessage,
  sendAnnouncement,
  sendGroupMessage,
  togglePinMessage,
  toggleStarMessage,
  getAllStarredMessages,
  getChatStates,
  updateChatState,
  getModerationMessages,
  moderateMessage
} = require('../controllers/messageController');

router.post('/', auth, sendMessage);
router.post('/send', auth, sendMessage);
router.post('/announcements', auth, sendAnnouncement);
router.get('/announcements', auth, getAnnouncements);
router.get('/attachments', auth, getChatAttachments);
router.get('/search', auth, searchMessages);
router.get('/flagged', auth, getFlaggedMessages);
router.get('/moderation', auth, requireRole('Administrator'), getModerationMessages);
router.patch('/moderation/:id', auth, requireRole('Administrator'), moderateMessage);
router.post('/pin', auth, togglePinMessage);
router.post('/star', auth, toggleStarMessage);
router.get('/starred', auth, getAllStarredMessages);
router.get('/chat-states', auth, getChatStates);
router.patch('/chat-state', auth, updateChatState);
router.get('/groups/:groupId', auth, getGroupMessages);
router.post('/groups/:groupId', auth, sendGroupMessage);
router.get('/unread-by-sender', auth, getUnreadBySender);
router.get('/inbox', auth, getInbox);
router.get('/sent', auth, getSent);
router.get('/conversation/:userId', auth, getConversation);
router.put('/:id', auth, editMessage);
router.delete('/:id', auth, deleteMessage);
router.post('/react', auth, reactToMessage);

module.exports = router;
