const assert = require("node:assert/strict");
const test = require("node:test");

function routePaths(router) {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const methods = Object.keys(layer.route.methods).sort().join(",");
      return `${methods.toUpperCase()} ${layer.route.path}`;
    })
    .sort();
}

test("message routes expose chat, search, attachment, and group endpoints", () => {
  const router = require("../routes/messageRoutes");
  const paths = routePaths(router);

  assert(paths.includes("GET /search"));
  assert(paths.includes("GET /attachments"));
  assert(paths.includes("GET /moderation"));
  assert(paths.includes("PATCH /moderation/:id"));
  assert(paths.includes("GET /groups/:groupId"));
  assert(paths.includes("POST /groups/:groupId"));
  assert(paths.includes("POST /announcements"));
});

test("user routes expose profile status and admin user management", () => {
  const router = require("../routes/userRoutes");
  const paths = routePaths(router);

  assert(paths.includes("PATCH /me/status"));
  assert(paths.includes("PATCH /me/password"));
  assert(paths.includes("PATCH /me/terms"));
  assert(paths.includes("PATCH /:id/suspension"));
  assert(paths.includes("POST /:id/password-reset"));
  assert(paths.includes("POST /"));
  assert(paths.includes("PUT /:id"));
  assert(paths.includes("DELETE /:id"));
});

test("audit routes expose administrator audit listing", () => {
  const router = require("../routes/auditRoutes");
  const paths = routePaths(router);

  assert.deepEqual(paths, ["GET /"]);
});

test("organization routes expose channels, ticket lists, and management endpoints", () => {
  const router = require("../routes/organizationRoutes");
  const paths = routePaths(router);

  assert(paths.includes("GET /"));
  assert(paths.includes("POST /"));
  assert(paths.includes("GET /tickets/my"));
  assert(paths.includes("GET /tickets/managed"));
  assert(paths.includes("PATCH /tickets/:ticketId"));
  assert(paths.includes("GET /:id/messages"));
  assert(paths.includes("POST /:id/announcements"));
  assert(paths.includes("GET /:id/tickets"));
  assert(paths.includes("POST /:id/tickets"));
  assert(paths.includes("GET /:id/tickets/pinned"));
  assert(paths.includes("POST /:id/join"));
  assert(paths.includes("POST /:id/leave"));
  assert(paths.includes("PATCH /:id/members"));
  assert(paths.includes("PATCH /:id/subjects"));
});
