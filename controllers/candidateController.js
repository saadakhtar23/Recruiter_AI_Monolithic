const jwt = require('jsonwebtoken');
const { sendEmail } = require('../utils/email');
const { generateApplicationId } = require('../utils/helpers');
const { cloudinary, upload } = require('../utils/cloudinary');

// Generate JWT token
const generateToken = (data) => {
  return jwt.sign(data, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d'
  });
};

// @desc    Register candidate
// @route   POST /api/candidates/register
// @access  Public
const registerCandidate = async (req, res) => {
  try {
    const {
      personalInfo,
      contactInfo,
      professionalInfo,
      education,
      experience,
      preferences,
      account: { password }
    } = req.body;

    const Candidate = require('../models/tenant/Candidate')(req.db);

    // Check if candidate already exists
    const existingCandidate = await Candidate.findOne({ 
      'personalInfo.email': personalInfo.email 
    });

    if (existingCandidate) {
      return res.status(400).json({
        success: false,
        message: 'Candidate with this email already exists'
      });
    }

    // Create candidate
    const candidate = await Candidate.create({
      personalInfo,
      contactInfo,
      professionalInfo,
      education,
      experience,
      preferences,
      account: {
        password,
        isActive: true,
        isEmailVerified: false
      }
    });

    // Generate token
    const token = generateToken(candidate._id);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        candidate: {
          id: candidate._id,
          name: candidate.fullName,
          email: candidate.personalInfo.email,
          isEmailVerified: candidate.account.isEmailVerified
        },
        token,
        tenant: {
          companyName: req.tenant.companyName,
          branding: req.tenant.branding
        }
      }
    });
  } catch (error) {
    console.error('Candidate registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Error during registration',
      error: error.message
    });
  }
};

// @desc    Login candidate
// @route   POST /api/candidates/login
// @access  Public
const loginCandidate = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const Candidate = require('../models/tenant/Candidate')(req.db);

    // Find candidate and include password
    const candidate = await Candidate.findOne({ 
      'personalInfo.email': email 
    }).select('+account.password');

    if (!candidate) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if account is locked
    if (candidate.isLocked) {
      return res.status(423).json({
        success: false,
        message: 'Account is temporarily locked due to too many failed login attempts'
      });
    }

    // Check if account is active
    if (!candidate.account.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    // Check password
    const isPasswordValid = await candidate.matchPassword(password);

    if (!isPasswordValid) {
      await candidate.incLoginAttempts();
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Reset login attempts on successful login
    if (candidate.account.loginAttempts > 0) {
      await candidate.resetLoginAttempts();
    }

    // Update last login
    candidate.account.lastLogin = new Date();
    await candidate.save();

    // Generate token with tenant info
    const token = generateToken({
      id: candidate._id,
      tenant: req.tenant.subdomain, // Add tenant subdomain
      type: 'candidate'
    });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        candidate: {
          id: candidate._id,
          name: candidate.fullName,
          email: candidate.personalInfo.email,
          lastLogin: candidate.account.lastLogin
        },
        token,
        tenant: {
          companyName: req.tenant.companyName,
          branding: req.tenant.branding,
          subdomain: req.tenant.subdomain // Add this for clarity
        }
      }
    });
  } catch (error) {
    console.error('Candidate login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error during login',
      error: error.message
    });
  }
};

// @desc    Get candidate profile
// @route   GET /api/candidates/profile
// @access  Private (Candidate)
const getCandidateProfile = async (req, res) => {
  try {
    const Candidate = require('../models/tenant/Candidate')(req.db);
    const candidate = await Candidate.findById(req.user.id);

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    res.status(200).json({
      success: true,
      data: { candidate }
    });
  } catch (error) {
    console.error('Get candidate profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching profile',
      error: error.message
    });
  }
};

// @desc    Update candidate profile
// @route   PUT /api/candidates/profile
// @access  Private (Candidate)
const updateCandidateProfile = async (req, res) => {
  try {
    const Candidate = require('../models/tenant/Candidate')(req.db);
    
    const candidate = await Candidate.findByIdAndUpdate(
      req.user.id,
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: { candidate }
    });
  } catch (error) {
    console.error('Update candidate profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};

// @desc    Apply to job
// @route   POST /api/candidates/apply/:jobId
// @access  Public (with candidate registration)
const applyToJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const {
      candidateData,
      coverLetter,
      customAnswers,
      documents
    } = req.body;

    const JobDescription = require('../models/tenant/JobDescription')(req.db);
    const Candidate = require('../models/tenant/Candidate')(req.db);
    const Application = require('../models/tenant/Application')(req.db);

    // Find job with active status and published
    const job = await JobDescription.findOne({
      $or: [
        { _id: jobId },
        { shareableLink: jobId }
      ],
      isActive: true,
      status: 'published'
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found or no longer available'
      });
    }

    // Check if application deadline has passed
    if (job.isDeadlinePassed) {
      return res.status(410).json({
        success: false,
        message: 'Application deadline has passed'
      });
    }

    // Check if candidate exists or create new one
    let candidate = await Candidate.findOne({ 
      'personalInfo.email': candidateData.personalInfo.email 
    });

    if (!candidate) {
      // Create new candidate
      candidate = await Candidate.create({
        ...candidateData,
        account: {
          password: candidateData.password || 'TempPassword123!',
          isActive: true,
          isEmailVerified: false
        }
      });
    }

    // Check if candidate has already applied
    const existingApplication = await Application.findOne({
      jobDescriptionId: job._id,
      candidateId: candidate._id
    });

    if (existingApplication && !job.applicationSettings.allowMultipleApplications) {
      return res.status(400).json({
        success: false,
        message: 'You have already applied for this position'
      });
    }

    // Create application
    const application = await Application.create({
      jobDescriptionId: job._id,
      candidateId: candidate._id,
      coverLetter,
      customAnswers,
      documents,
      status: 'submitted'
    });

    // Increment job application count
    await job.incrementApplications();

    // Send confirmation email
    await sendEmail({
      to: candidate.personalInfo.email,
      template: 'application-received',
      data: {
        candidateName: candidate.fullName,
        jobTitle: job.title,
        companyName: req.tenant.companyName,
        appliedDate: new Date().toLocaleDateString(),
        applicationId: application._id
      }
    });

    res.status(201).json({
      success: true,
      message: 'Application submitted successfully',
      data: {
        application: {
          id: application._id,
          status: application.status,
          appliedAt: application.appliedAt
        },
        candidate: {
          id: candidate._id,
          name: candidate.fullName,
          email: candidate.personalInfo.email
        }
      }
    });
  } catch (error) {
    console.error('Apply to job error:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting application',
      error: error.message
    });
  }
};

// @desc    Get candidate applications
// @route   GET /api/candidates/applications
// @access  Private (Candidate)
const getCandidateApplications = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = 'appliedAt',
      sortOrder = 'desc'
    } = req.query;

    const Application = require('../models/tenant/Application')(req.db);

    // Build query
    const query = { candidateId: req.user.id };
    if (status) query.status = status;

    // Execute query with pagination
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { [sortBy]: sortOrder === 'desc' ? -1 : 1 }
    };

    const applications = await Application.find(query)
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit)
      .populate('jobDescriptionId', 'title status location employmentType');

    const total = await Application.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        applications,
        pagination: {
          current: options.page,
          pages: Math.ceil(total / options.limit),
          total,
          limit: options.limit
        }
      }
    });
  } catch (error) {
    console.error('Get candidate applications error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching applications',
      error: error.message
    });
  }
};

// @desc    Upload document
// @route   POST /api/candidates/upload-document
// @access  Private (Candidate)
const uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload a file'
      });
    }

    const { documentType } = req.body;

    // Validate document type
    const validDocumentTypes = ['resume', 'coverLetter', 'certificate', 'profilePicture'];
    if (!validDocumentTypes.includes(documentType)) {
      // Delete uploaded file if document type is invalid
      if (req.file.public_id) {
        await cloudinary.uploader.destroy(req.file.public_id);
      }
      return res.status(400).json({
        success: false,
        message: 'Invalid document type'
      });
    }

    const Candidate = require('../models/tenant/Candidate')(req.db);

    // Format document data
    const documentData = {
      url: req.file.path,
      publicId: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date()
    };

    // If it's a profile picture, handle image optimization
    if (documentType === 'profilePicture') {
      documentData.url = cloudinary.url(req.file.public_id, {
        width: 300,
        height: 300,
        crop: 'fill',
        format: 'jpg'
      });
    }

    // Delete old document if exists
    const candidate = await Candidate.findById(req.user.id);
    if (candidate.documents && candidate.documents[documentType] && candidate.documents[documentType].publicId) {
      await cloudinary.uploader.destroy(candidate.documents[documentType].publicId);
    }

    // Update candidate document
    const updateField = `documents.${documentType}`;
    const updatedCandidate = await Candidate.findByIdAndUpdate(
      req.user.id,
      { [updateField]: documentData },
      { new: true }
    );

    if (!updatedCandidate) {
      // Delete uploaded file if candidate update fails
      await cloudinary.uploader.destroy(req.file.public_id);
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        document: {
          type: documentType,
          ...documentData
        }
      }
    });

  } catch (error) {
    console.error('Upload document error:', error);
    // Delete uploaded file if any other error occurs
    if (req.file && req.file.public_id) {
      await cloudinary.uploader.destroy(req.file.public_id);
    }
    res.status(500).json({
      success: false,
      message: 'Error uploading document',
      error: error.message
    });
  }
};

module.exports = {
  registerCandidate,
  loginCandidate,
  getCandidateProfile,
  updateCandidateProfile,
  applyToJob,
  getCandidateApplications,
  uploadDocument
};