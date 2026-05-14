const OrganizationChannel = require('../models/OrganizationChannel');
const Ticket = require('../models/Ticket');
const Message = require('../models/Message');
const User = require('../models/User');
const { recordAudit } = require('../services/auditService');

const ORG_ROLES = ['Member', 'Co-Admin', 'Admin', 'Main Admin'];
const TICKET_STATUSES = ['pending', 'accepted', 'in_progress', 'waiting', 'verify', 'resolved', 'closed', 'invalid'];
const ACTIVE_TICKET_STATUSES = ['pending', 'accepted', 'in_progress', 'waiting', 'verify', 'resolved'];
const ORG_ROLE_PERMISSIONS = {
  VIEW_ANNOUNCEMENTS: ['Member', 'Co-Admin', 'Admin', 'Main Admin'],
  CREATE_TICKETS_FOR_OTHERS: ['Co-Admin', 'Admin', 'Main Admin'],
  MANAGE_TICKETS: ['Co-Admin', 'Admin', 'Main Admin'],
  POST_ANNOUNCEMENTS: ['Admin', 'Main Admin'],
  MANAGE_MEMBERS: ['Main Admin'],
  MANAGE_SUBJECTS: ['Main Admin'],
};

function canCreateOrganization(user) {
  const roles = Array.isArray(user?.roles) && user.roles.length
    ? user.roles
    : [user?.role].filter(Boolean);
  return roles.some((role) => ['Administrator', 'Department Head'].includes(role));
}

function idString(value) {
  if (value == null) return '';
  if (typeof value === 'object') return String(value._id || value.id || '');
  return String(value);
}

function memberIdsFromBody(value, ownerId) {
  const rows = Array.isArray(value) ? value : [];
  const normalized = rows
    .map((row) => {
      const userId = typeof row === 'object' ? row.userId : row;
      const role = typeof row === 'object' && ORG_ROLES.includes(row.role) ? row.role : 'Member';
      return { userId: String(userId || '').trim(), role };
    })
    .filter((row) => /^[a-fA-F0-9]{24}$/.test(row.userId));

  const byUser = new Map(normalized.map((row) => [row.userId, row]));
  byUser.set(String(ownerId), { userId: String(ownerId), role: 'Main Admin' });
  return Array.from(byUser.values());
}

function serializeOrganization(org) {
  if (!org) return null;
  const raw = typeof org.toObject === 'function' ? org.toObject({ versionKey: false }) : org;
  return {
    ...raw,
    _id: idString(raw._id),
    createdBy: raw.createdBy,
    members: Array.isArray(raw.members) ? raw.members : [],
    subjects: Array.isArray(raw.subjects) ? raw.subjects : [],
  };
}

function membershipFor(org, userId) {
  return (org?.members || []).find((member) => idString(member.userId) === String(userId));
}

function organizationMessageStartDate(org, membership) {
  return membership?.joinedBySelf ? membership.addedAt || new Date() : new Date(0);
}

function hasOrgRole(org, userId, roles) {
  const membership = membershipFor(org, userId);
  return Boolean(membership && roles.includes(membership.role));
}

function hasOrgPermission(org, userId, permission) {
  return hasOrgRole(org, userId, ORG_ROLE_PERMISSIONS[permission] || []);
}

async function findOrganizationForMember(id, userId) {
  return OrganizationChannel.findOne({ _id: id, 'members.userId': userId });
}

async function populatedOrganization(id) {
  return OrganizationChannel.findById(id)
    .populate('createdBy', 'name email avatarUrl')
    .populate('members.userId', 'name email avatarUrl department role');
}

function ticketStatusLabel(status) {
  return String(status || '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ticketMessageContent(ticket) {
  if (!ticket.ticketNumber) {
    return `Ticket pending\nSubject: ${ticket.subject}`;
  }
  return `Ticket Number: ${ticket.ticketNumber} - ${ticketStatusLabel(ticket.status)}\nSubject: ${ticket.subject}`;
}

function sanitizeAttachments(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((file) => ({
      fileName: String(file?.fileName || '').slice(0, 300),
      originalName: String(file?.originalName || '').slice(0, 300),
      url: String(file?.url || '').slice(0, 1000),
      mimetype: String(file?.mimetype || '').slice(0, 200),
      type: ['image', 'pdf', 'other'].includes(file?.type) ? file.type : 'other',
      size: Number.isFinite(file?.size) ? file.size : undefined,
    }))
    .filter((file) => file.url);
}

async function generateTicketNumber(org) {
  const prefix = String(org.name || 'ORG')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase()
    .padEnd(3, 'X');
  const count = await Ticket.countDocuments({ organizationId: org._id, ticketNumber: { $ne: null } });
  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
}

async function emitOrganization(req, org, eventName, payload) {
  const io = req.app.get('io');
  if (!io || !org) return;
  const memberIds = (org.members || []).map((member) => idString(member.userId || member)).filter(Boolean);
  memberIds.forEach((id) => io.to(id).emit(eventName, payload));
}

function serializeTicket(ticket) {
  if (!ticket) return null;
  const raw = typeof ticket.toObject === 'function' ? ticket.toObject({ versionKey: false }) : ticket;
  return {
    ...raw,
    _id: idString(raw._id),
    organizationId: raw.organizationId,
    requestorId: raw.requestorId,
    createdForId: raw.createdForId || null,
    assigneeId: raw.assigneeId || null,
    messageId: raw.messageId || null,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

exports.listOrganizations = async (req, res, next) => {
  try {
    const organizations = await OrganizationChannel.find({})
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate('createdBy', 'name email avatarUrl')
      .populate('members.userId', 'name email avatarUrl department role')
      .lean();

    const latestRows = await Promise.all(
      organizations.map(async (org) => {
        const membership = membershipFor(org, req.user.id);
        if (!membership) return [String(org._id), null];
        const last = await Message.findOne({
          organizationId: org._id,
          channel: 'organization',
          createdAt: { $gte: organizationMessageStartDate(org, membership) },
        })
          .sort({ _id: -1 })
          .select('_id content createdAt attachments')
          .lean();
        return [String(org._id), last || null];
      })
    );
    const latestByOrganization = Object.fromEntries(latestRows);

    res.json(
      organizations.map((org) => ({
        ...serializeOrganization(org),
        isMember: Boolean(membershipFor(org, req.user.id)),
        lastMessage: latestByOrganization[String(org._id)],
      }))
    );
  } catch (err) {
    next(err);
  }
};

exports.joinOrganization = async (req, res, next) => {
  try {
    const org = await OrganizationChannel.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    if (!membershipFor(org, req.user.id)) {
      org.members.push({ userId: req.user.id, role: 'Member', addedAt: new Date(), joinedBySelf: true });
      await org.save();
      await recordAudit(req, {
        action: 'organization.member_joined',
        targetType: 'organization',
        targetId: org._id,
        targetName: org.name,
        details: { userId: req.user.id },
      });
    }

    const populated = await populatedOrganization(org._id);
    await emitOrganization(req, populated, 'organization:updated', serializeOrganization(populated));
    res.json(serializeOrganization(populated));
  } catch (err) {
    next(err);
  }
};

exports.createOrganization = async (req, res, next) => {
  try {
    if (!canCreateOrganization(req.user)) {
      return res.status(403).json({ message: 'Only Department Heads can create organization channels' });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ message: 'Organization channel name is required' });

    const members = memberIdsFromBody(req.body?.members || req.body?.memberIds, req.user.id);
    const subjects = (Array.isArray(req.body?.subjects) ? req.body.subjects : [])
      .map((subject) => String(typeof subject === 'object' ? subject.name : subject).trim())
      .filter(Boolean)
      .map((name) => ({ name }));

    const org = await OrganizationChannel.create({
      name,
      description: typeof req.body?.description === 'string' ? req.body.description.trim() : '',
      avatarUrl: typeof req.body?.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '',
      createdBy: req.user.id,
      members,
      subjects,
      lastMessageAt: new Date(),
    });

    const populated = await populatedOrganization(org._id);
    await recordAudit(req, {
      action: 'organization.created',
      targetType: 'organization',
      targetId: org._id,
      targetName: org.name,
      details: { members: members.length },
    });
    await emitOrganization(req, populated, 'organization:updated', serializeOrganization(populated));
    res.status(201).json(serializeOrganization(populated));
  } catch (err) {
    next(err);
  }
};

exports.updateOrganizationMembers = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    if (!hasOrgPermission(org, req.user.id, 'MANAGE_MEMBERS')) {
      return res.status(403).json({ message: 'Only Main Admins can manage members' });
    }

    org.members = memberIdsFromBody(req.body?.members || req.body?.memberIds, idString(org.createdBy));
    await org.save();
    const populated = await populatedOrganization(org._id);
    await recordAudit(req, {
      action: 'organization.members_updated',
      targetType: 'organization',
      targetId: org._id,
      targetName: org.name,
      details: { members: org.members.length },
    });
    await emitOrganization(req, populated, 'organization:updated', serializeOrganization(populated));
    res.json(serializeOrganization(populated));
  } catch (err) {
    next(err);
  }
};

exports.updateOrganizationSubjects = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    if (!hasOrgPermission(org, req.user.id, 'MANAGE_SUBJECTS')) {
      return res.status(403).json({ message: 'Only Main Admins can manage subjects' });
    }

    org.subjects = (Array.isArray(req.body?.subjects) ? req.body.subjects : [])
      .map((subject) => ({
        name: String(typeof subject === 'object' ? subject.name : subject).trim(),
        active: typeof subject === 'object' && subject.active === false ? false : true,
      }))
      .filter((subject) => subject.name);
    await org.save();
    const populated = await populatedOrganization(org._id);
    await emitOrganization(req, populated, 'organization:updated', serializeOrganization(populated));
    res.json(serializeOrganization(populated));
  } catch (err) {
    next(err);
  }
};

exports.updateOrganizationDetails = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    if (!hasOrgPermission(org, req.user.id, 'MANAGE_SUBJECTS')) {
      return res.status(403).json({ message: 'Only Main Admins can edit organization details' });
    }

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      org.name = req.body.name.trim();
    }
    if (typeof req.body?.avatarUrl === 'string') {
      org.avatarUrl = req.body.avatarUrl.trim();
    }

    await org.save();
    const populated = await populatedOrganization(org._id);
    await emitOrganization(req, populated, 'organization:updated', serializeOrganization(populated));
    res.json(serializeOrganization(populated));
  } catch (err) {
    next(err);
  }
};

exports.leaveOrganization = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });

    const userId = String(req.user.id);
    const currentMembers = Array.isArray(org.members) ? org.members : [];
    const currentMembership = membershipFor(org, userId);
    const mainAdminCount = currentMembers.filter((member) => member.role === 'Main Admin').length;
    if (currentMembership?.role === 'Main Admin' && mainAdminCount <= 1) {
      return res.status(400).json({ message: 'Assign another Main Admin before leaving this organization channel' });
    }

    org.members = currentMembers.filter((member) => idString(member.userId) !== userId);
    await org.save();
    const populated = await populatedOrganization(org._id);
    await recordAudit(req, {
      action: 'organization.member_left',
      targetType: 'organization',
      targetId: org._id,
      targetName: org.name,
      details: { userId },
    });
    await emitOrganization(req, populated, 'organization:updated', serializeOrganization(populated));
    res.json({ success: true, organizationId: idString(org._id) });
  } catch (err) {
    next(err);
  }
};

exports.getOrganizationMessages = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    const membership = membershipFor(org, req.user.id);

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 40, 100);
    const items = await Message.find({
      organizationId: org._id,
      channel: 'organization',
      createdAt: { $gte: organizationMessageStartDate(org, membership) },
    })
      .sort({ _id: -1 })
      .limit(limit)
      .populate('senderId', 'name email avatarUrl')
      .populate('organizationId', 'name avatarUrl members subjects')
      .lean();
    res.json({ items: items.reverse() });
  } catch (err) {
    next(err);
  }
};

exports.createOrganizationMessage = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });

    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const attachments = sanitizeAttachments(req.body?.attachments);
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
    if (!content.trim() && !attachments.length) {
      return res.status(400).json({ message: 'Message body or attachment required' });
    }

    const message = await Message.create({
      senderId: req.user.id,
      receiverId: null,
      organizationId: org._id,
      channel: 'organization',
      content,
      attachments,
      organizationMessageType: null,
    });

    org.lastMessageAt = new Date();
    await org.save();

    await message.populate('senderId', 'name email avatarUrl');
    await message.populate('organizationId', 'name avatarUrl members subjects');
    const payload = {
      ...message.toObject(),
      ...(clientId ? { clientId } : {}),
    };
    await emitOrganization(req, org, 'message:new', payload);
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
};

exports.createOrganizationAnnouncement = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    if (!hasOrgPermission(org, req.user.id, 'POST_ANNOUNCEMENTS')) {
      return res.status(403).json({ message: 'Only organization Admins and Main Admins can post announcements' });
    }

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : 'Announcement';
    if (!content) return res.status(400).json({ message: 'Announcement message is required' });

    const message = await Message.create({
      senderId: req.user.id,
      organizationId: org._id,
      receiverId: null,
      groupId: null,
      channel: 'organization',
      organizationMessageType: 'announcement',
      subject,
      content,
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    });
    org.lastMessageAt = new Date();
    await org.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('senderId', 'name email avatarUrl')
      .populate('organizationId', 'name avatarUrl members subjects');
    await emitOrganization(req, org, 'message:new', populatedMessage.toObject());
    await recordAudit(req, {
      action: 'organization.announcement_sent',
      targetType: 'organization',
      targetId: org._id,
      targetName: org.name,
      details: { subject },
    });
    res.status(201).json({ message: populatedMessage });
  } catch (err) {
    next(err);
  }
};

exports.createTicket = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });

    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const dateNeeded = new Date(req.body?.dateNeeded);
    if (!subject || !description || Number.isNaN(dateNeeded.getTime())) {
      return res.status(400).json({ message: 'Subject, description, and date needed are required' });
    }

    const createdForId = req.body?.createdForId;
    if (createdForId && !hasOrgPermission(org, req.user.id, 'CREATE_TICKETS_FOR_OTHERS')) {
      return res.status(403).json({ message: 'Only organization admins can create tickets for others' });
    }

    const ticket = await Ticket.create({
      organizationId: org._id,
      requestorId: req.user.id,
      createdForId: /^[a-fA-F0-9]{24}$/.test(String(createdForId || '')) ? createdForId : req.user.id,
      subject,
      description,
      dateNeeded,
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
      history: [{
        action: 'ticket.created',
        actorId: req.user.id,
        actorName: req.user.name || req.user.email,
        toStatus: 'pending',
      }],
    });

    const message = await Message.create({
      senderId: req.user.id,
      organizationId: org._id,
      receiverId: null,
      groupId: null,
      channel: 'organization',
      organizationMessageType: 'ticket',
      subject,
      content: ticketMessageContent(ticket),
      attachments: ticket.attachments,
    });
    ticket.messageId = message._id;
    await ticket.save();

    org.lastMessageAt = new Date();
    await org.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('senderId', 'name email avatarUrl')
      .populate('organizationId', 'name avatarUrl members subjects');
    await emitOrganization(req, org, 'message:new', populatedMessage.toObject());
    await emitOrganization(req, org, 'ticket:created', serializeTicket(ticket));
    res.status(201).json({ ticket: serializeTicket(ticket), message: populatedMessage });
  } catch (err) {
    next(err);
  }
};

exports.listOrganizationTickets = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    const canManage = hasOrgPermission(org, req.user.id, 'MANAGE_TICKETS');
    const filter = { organizationId: org._id };
    if (!canManage) {
      filter.$or = [{ requestorId: req.user.id }, { createdForId: req.user.id }];
    }
    const status = String(req.query.status || '');
    if (TICKET_STATUSES.includes(status)) filter.status = status;

    const items = await Ticket.find(filter)
      .sort({ updatedAt: -1 })
      .populate('requestorId', 'name email avatarUrl department')
      .populate('createdForId', 'name email avatarUrl department')
      .populate('assigneeId', 'name email avatarUrl department')
      .lean();
    res.json({ items: items.map(serializeTicket) });
  } catch (err) {
    next(err);
  }
};

exports.listMyTickets = async (req, res, next) => {
  try {
    const orgs = await OrganizationChannel.find({ 'members.userId': req.user.id }).select('_id').lean();
    const orgIds = orgs.map((org) => org._id);
    const items = await Ticket.find({
      organizationId: { $in: orgIds },
      $or: [{ requestorId: req.user.id }, { createdForId: req.user.id }],
    })
      .sort({ updatedAt: -1 })
      .populate('organizationId', 'name avatarUrl')
      .populate('requestorId', 'name email avatarUrl department')
      .populate('createdForId', 'name email avatarUrl department')
      .populate('assigneeId', 'name email avatarUrl department')
      .lean();
    res.json({ items: items.map(serializeTicket) });
  } catch (err) {
    next(err);
  }
};

exports.listManagedTickets = async (req, res, next) => {
  try {
    const orgs = await OrganizationChannel.find({
      members: {
        $elemMatch: {
          userId: req.user.id,
          role: { $in: ['Co-Admin', 'Admin', 'Main Admin'] },
        },
      },
    }).select('_id').lean();
    const items = await Ticket.find({ organizationId: { $in: orgs.map((org) => org._id) } })
      .sort({ updatedAt: -1 })
      .populate('organizationId', 'name avatarUrl')
      .populate('requestorId', 'name email avatarUrl department')
      .populate('createdForId', 'name email avatarUrl department')
      .populate('assigneeId', 'name email avatarUrl department')
      .lean();
    res.json({ items: items.map(serializeTicket) });
  } catch (err) {
    next(err);
  }
};

exports.listActivePinnedTickets = async (req, res, next) => {
  try {
    const org = await findOrganizationForMember(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    const items = await Ticket.find({
      organizationId: org._id,
      status: { $in: ACTIVE_TICKET_STATUSES },
    })
      .sort({ updatedAt: -1 })
      .limit(2)
      .populate('requestorId', 'name email avatarUrl department')
      .lean();
    res.json({ items: items.map(serializeTicket) });
  } catch (err) {
    next(err);
  }
};

exports.updateTicket = async (req, res, next) => {
  try {
    const ticket = await Ticket.findById(req.params.ticketId);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    const org = await findOrganizationForMember(ticket.organizationId, req.user.id);
    if (!org) return res.status(404).json({ message: 'Organization channel not found' });
    const isOrganizationAdmin = hasOrgPermission(org, req.user.id, 'MANAGE_TICKETS');
    const isTicketRequestor =
      idString(ticket.requestorId) === String(req.user.id) ||
      idString(ticket.createdForId) === String(req.user.id);
    const requestedStatus = String(req.body?.status || ticket.status);
    const requestorVerificationMove =
      ticket.status === 'verify' && ['resolved', 'waiting'].includes(requestedStatus);

    if (requestorVerificationMove && !isTicketRequestor) {
      return res.status(403).json({ message: 'Only the requestor can verify this ticket' });
    }
    if (!requestorVerificationMove && !isOrganizationAdmin) {
      return res.status(403).json({ message: 'Only organization admins can manage tickets' });
    }

    const nextStatus = requestedStatus;
    if (!TICKET_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: 'Invalid ticket status' });
    }

    const fromStatus = ticket.status;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    const actionTaken = typeof req.body?.actionTaken === 'string' ? req.body.actionTaken.trim().slice(0, 1500) : '';
    const verificationComment =
      typeof req.body?.verificationComment === 'string'
        ? req.body.verificationComment.trim().slice(0, 1500)
        : '';
    const updateAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

    if (fromStatus === 'waiting' && nextStatus === 'verify' && !actionTaken && !ticket.actionTaken) {
      return res.status(400).json({ message: 'Action taken is required before moving to Verify' });
    }
    if (fromStatus === 'verify' && nextStatus === 'waiting' && !verificationComment) {
      return res.status(400).json({ message: 'A requestor comment is required when verification is not resolved' });
    }
    if (fromStatus === 'in_progress' && ticket.actionTaken && nextStatus === 'accepted') {
      return res.status(400).json({ message: 'Ticket with action taken cannot be moved back to Accepted' });
    }

    ticket.status = nextStatus;
    if (actionTaken) ticket.actionTaken = actionTaken;
    if (verificationComment) ticket.verificationComment = verificationComment;
    if (updateAttachments.length) {
      ticket.attachments.push(...updateAttachments);
    }
    if (req.body?.assigneeId && /^[a-fA-F0-9]{24}$/.test(String(req.body.assigneeId))) {
      const assignee = await User.findById(req.body.assigneeId).select('_id');
      if (assignee) ticket.assigneeId = assignee._id;
    }
    if (nextStatus !== 'pending' && !ticket.ticketNumber) {
      ticket.ticketNumber = await generateTicketNumber(org);
    }
    ticket.history.push({
      action: 'ticket.updated',
      fromStatus,
      toStatus: nextStatus,
      actorId: req.user.id,
      actorName: req.user.name || req.user.email,
      note: note || actionTaken || verificationComment,
      attachments: updateAttachments,
    });
    await ticket.save();

    let updatedMessage = null;
    if (ticket.messageId) {
      updatedMessage = await Message.findById(ticket.messageId);
      if (updatedMessage) {
        updatedMessage.content = ticketMessageContent(ticket);
        await updatedMessage.save();
        await updatedMessage.populate('senderId', 'name email avatarUrl');
        await updatedMessage.populate('organizationId', 'name avatarUrl members subjects');
      }
    }

    await emitOrganization(req, org, 'ticket:updated', serializeTicket(ticket));
    if (updatedMessage) await emitOrganization(req, org, 'message:updated', updatedMessage.toObject());
    await recordAudit(req, {
      action: 'ticket.updated',
      targetType: 'ticket',
      targetId: ticket._id,
      targetName: ticket.ticketNumber || ticket.subject,
      details: { fromStatus, toStatus: nextStatus },
    });
    res.json({ ticket: serializeTicket(ticket), message: updatedMessage });
  } catch (err) {
    next(err);
  }
};
