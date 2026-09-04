with open('src/server.js', 'r', encoding='utf-8') as f:
    code = f.read()

s = '''try {
  try {
    const aiRoutes = require("./routes/ai");
    app.use("/api/ai", authRole(["any"]), aiRoutes);
  } catch (e) {
    console.warn('ai routes not mounted:', e.message);
  }

  try {
    const trackingRoutes = require("./routes/tracking");
    const adminTrackingRoutes = require("./routes/adminTracking");
    app.use("/api/tracking", trackingRoutes);
    app.use("/api/admin/tracking", authRole(["admin", "mainadmin"]), adminTrackingRoutes);
  } catch (e) {
    console.warn('tracking routes not mounted:', e.message);
  }
} catch (e) {
  console.warn('ai routes not mounted:', e.message);
}'''
api = '''try {
  const aiRoutes = require("./routes/ai");
  app.use("/api/ai", authRole(["any"]), aiRoutes);
} catch (e) {
  console.warn('ai routes not mounted:', e.message);
}

try {
  const trackingRoutes = require("./routes/tracking");
  const adminTrackingRoutes = require("./routes/adminTracking");
  app.use("/api/tracking", trackingRoutes);
  app.use("/api/admin/tracking", authRole(["admin", "mainadmin"]), adminTrackingRoutes);
} catch (e) {
  console.warn('tracking routes not mounted:', e.message);
}'''
code = code.replace(s, api)

with open('src/server.js', 'w', encoding='utf-8') as f:
    f.write(code)
