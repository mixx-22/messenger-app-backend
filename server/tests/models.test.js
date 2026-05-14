const assert = require("node:assert/strict");
const test = require("node:test");

test("User schema supports presence statuses", () => {
  const User = require("../models/User");
  const statusPath = User.schema.path("status");

  assert.deepEqual(statusPath.enumValues.sort(), [
    "available",
    "away",
    "busy",
    "invisible",
  ]);
  assert(User.schema.path("role").enumValues.includes("Department Head"));
  assert.equal(User.schema.path("statusMessage").instance, "String");
  assert.equal(User.schema.path("mustChangePassword").instance, "Boolean");
  assert.equal(User.schema.path("termsAcceptedAt").instance, "Date");
  assert.equal(User.schema.path("termsVersion").instance, "String");
  assert.equal(User.schema.path("contactNumber").instance, "String");
  assert.equal(User.schema.path("birthday").instance, "Date");
  assert.equal(User.schema.path("suspended").instance, "Boolean");
  assert.equal(User.schema.path("suspendReason").instance, "String");
});

test("Message schema indexes searchable content and attachment metadata", () => {
  const Message = require("../models/Message");
  const indexes = Message.schema.indexes();

  assert(
    indexes.some(([fields]) => fields.subject === "text" && fields.content === "text"),
  );
  assert.equal(Message.schema.path("attachments").$isMongooseDocumentArray, true);
  assert(Message.schema.path("channel").enumValues.includes("organization"));
  assert.equal(Message.schema.path("organizationId").instance, "ObjectId");
  assert.deepEqual(Message.schema.path("organizationMessageType").enumValues.sort(), [
    "announcement",
    "ticket",
    null,
  ].sort());
  assert.equal(Message.schema.path("moderated").instance, "Boolean");
  assert.equal(Message.schema.path("moderationReason").instance, "String");
});

test("Organization channel and Ticket schemas support ticket workflow", () => {
  const OrganizationChannel = require("../models/OrganizationChannel");
  const Ticket = require("../models/Ticket");

  assert.equal(OrganizationChannel.schema.path("members").$isMongooseDocumentArray, true);
  assert.equal(OrganizationChannel.schema.path("subjects").$isMongooseDocumentArray, true);
  const membershipSchema = OrganizationChannel.schema.path("members").schema;
  assert.deepEqual(
    membershipSchema.path("role").enumValues.sort(),
    ["Admin", "Co-Admin", "Main Admin", "Member"],
  );
  assert.deepEqual(
    Ticket.schema.path("status").enumValues.sort(),
    ["accepted", "closed", "in_progress", "invalid", "pending", "resolved", "verify", "waiting"],
  );
  assert.equal(Ticket.schema.path("organizationId").instance, "ObjectId");
  assert.equal(Ticket.schema.path("messageId").instance, "ObjectId");
  assert.equal(Ticket.schema.path("actionTaken").instance, "String");
  assert.equal(Ticket.schema.path("verificationComment").instance, "String");
});

test("AuditLog schema records actor, action, target, and details", () => {
  const AuditLog = require("../models/AuditLog");

  assert.equal(AuditLog.schema.path("action").isRequired, true);
  assert.equal(AuditLog.schema.path("actorName").instance, "String");
  assert.equal(AuditLog.schema.path("details").instance, "Mixed");
});
