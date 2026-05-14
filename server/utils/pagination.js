module.exports = (req) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  const skip = (page - 1) * limit;

  return { page, limit, skip };
};