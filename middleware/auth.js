const jwt = require('jsonwebtoken');
const dbManager = require('../config/database');
 
const protect = async (req, res, next) => {
  try {
    let token;
 
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
 
    if (!token) {
      return res.status(401).json({ success: false, message: 'Token missing' });
    }
 
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
 
    let Model;
 
    if (decoded.role === 'super_admin') {
      // ✅ Master DB for super admin
      req.db = dbManager.getMasterConnection();
      Model = require('../models/master/SuperAdmin')(req.db);
 
    } else {
      // ✅ Tenant-based users & candidates
 
      const tenant = decoded.tenant || req.headers['x-tenant-id'];
      if (!tenant) {
        return res.status(400).json({
          success: false,
          message: 'Tenant is required for this user type'
        });
      }
 
      req.db = await dbManager.getTenantDB(tenant);
      req.tenantId = tenant;
 
      if (decoded.type === 'candidate') {
        Model = require('../models/tenant/Candidate')(req.db);
      } else {
        Model = require('../models/tenant/User')(req.db);
      }
    }
 
    const user = await Model.findById(decoded.id).select('-password -account.password');
 
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
 
    if (!user.isActive && (!user.account || !user.account.isActive)) {
      return res.status(401).json({ success: false, message: 'Account is inactive' });
    }
 
    req.user = user;
    req.userType = decoded.type;
    next();
 
  } catch (error) {
    console.error("Auth Error =>", error);
    return res.status(401).json({
      success: false,
      message: 'Authentication failed',
      error: error.message
    });
  }
};
 
// ✅ Role authorization
const authorize = (...allowedTypes) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    //!roles.includes(req.user.role)
 
    if (!allowedTypes.includes(req.userType || req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `${req.userType} is not allowed to access this route`
      });
    }
 
    next();
  };
};
 
 
// ✅ Super Admin only
const superAdminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Super admin access only'
    });
  }
  next();
};
 
module.exports = { protect, authorize, superAdminOnly };