with open('src/server.js', 'r', encoding='utf-8') as f:
    code = f.read()

s = "const aiRoutes = require('./routes/ai');"
api = "const aiRoutes = require('./routes/ai');\nconst trackingRoutes = require('./routes/tracking');\nconst adminTrackingRoutes = require('./routes/adminTracking');"
code = code.replace(s, api)

s2 = '  app.use("/api/ai", authRole(["any"]), aiRoutes);'
api2 = '  app.use("/api/ai", authRole(["any"]), aiRoutes);\n  app.use("/api/tracking", trackingRoutes);\n  app.use("/api/admin/tracking", authRole(["admin", "mainadmin"]), adminTrackingRoutes);'
code = code.replace(s2, api2)

with open('src/server.js', 'w', encoding='utf-8') as f:
    f.write(code)
