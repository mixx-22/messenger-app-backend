const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const {
  createOrganization,
  createOrganizationMessage,
  createOrganizationAnnouncement,
  createTicket,
  getOrganizationMessages,
  listActivePinnedTickets,
  listManagedTickets,
  listMyTickets,
  listOrganizationTickets,
  listOrganizations,
  joinOrganization,
  leaveOrganization,
  updateOrganizationDetails,
  updateOrganizationMembers,
  updateOrganizationSubjects,
  updateTicket,
} = require('../controllers/organizationController');

router.get('/', auth, listOrganizations);
router.post('/', auth, createOrganization);
router.get('/tickets/my', auth, listMyTickets);
router.get('/tickets/managed', auth, listManagedTickets);
router.patch('/tickets/:ticketId', auth, updateTicket);
router.get('/:id/messages', auth, getOrganizationMessages);
router.post('/:id/messages', auth, createOrganizationMessage);
router.post('/:id/announcements', auth, createOrganizationAnnouncement);
router.get('/:id/tickets', auth, listOrganizationTickets);
router.post('/:id/tickets', auth, createTicket);
router.get('/:id/tickets/pinned', auth, listActivePinnedTickets);
router.post('/:id/join', auth, joinOrganization);
router.post('/:id/leave', auth, leaveOrganization);
router.patch('/:id', auth, updateOrganizationDetails);
router.patch('/:id/members', auth, updateOrganizationMembers);
router.patch('/:id/subjects', auth, updateOrganizationSubjects);

module.exports = router;
