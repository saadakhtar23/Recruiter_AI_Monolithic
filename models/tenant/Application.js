const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
    jobDescriptionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'JobDescription',
        required: [true, 'Job description ID is required']
    },
    candidateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Candidate',
        required: [true, 'Candidate ID is required']
    },
    status: {
        type: String,
        enum: [
            'submitted',
            'under_review',
            'shortlisted',
            'interview_scheduled',
            'interviewed',
            'selected',
            'rejected',
            'withdrawn',
            'on_hold'
        ],
        default: 'submitted'
    },
    appliedAt: {
        type: Date,
        default: Date.now
    },
    coverLetter: {
        type: String,
        maxlength: [2000, 'Cover letter cannot exceed 2000 characters']
    },
    Resume: {
        type: String,
        maxlength: [1000, 'Resume URL cannot exceed 1000 characters']
    },
    skills: [String],
    currentCTC: {
        type: Number,
        min: [0, 'Current CTC cannot be negative']
    },
    expectedCTC: {
        type: Number,
        min: [0, 'Expected CTC cannot be negative']
    },
    currentLocation: {
        type: String,
        maxlength: [100, 'Location cannot exceed 100 characters']
    },
    NoticePeriod: {
        type: Number, // in days
        min: [0, 'Notice period cannot be negative']
    },
    willingToRelocate: {
        type: Boolean,
        default: false
    },
    customAnswers: [{
        questionId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true
        },
        question: {
            type: String,
            required: true
        },
        answer: {
            type: mongoose.Schema.Types.Mixed, // Can be string, array, boolean
            required: true
        }
    }],
    documents: {
        resume: {
            filename: String,
            url: String,
            publicId: String,
            uploadedAt: Date
        },
        additionalDocuments: [{
            title: String,
            filename: String,
            url: String,
            publicId: String,
            uploadedAt: Date
        }]
    },
    screening: {
        score: {
            type: Number,
            min: 0,
            max: 100
        },
        notes: String,
        screenedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        screenedAt: Date,
        criteria: [{
            name: String,
            score: {
                type: Number,
                min: 0,
                max: 10
            },
            notes: String
        }]
    },
    interviews: [{
        type: {
            type: String,
            enum: ['phone', 'video', 'in-person', 'technical', 'hr', 'final'],
            required: true
        },
        scheduledAt: {
            type: Date,
            required: true
        },
        duration: {
            type: Number, // in minutes
            default: 60
        },
        interviewer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        status: {
            type: String,
            enum: ['scheduled', 'completed', 'cancelled', 'rescheduled'],
            default: 'scheduled'
        },
        feedback: {
            rating: {
                type: Number,
                min: 1,
                max: 5
            },
            strengths: [String],
            weaknesses: [String],
            notes: String,
            recommendation: {
                type: String,
                enum: ['strongly_recommend', 'recommend', 'neutral', 'not_recommend', 'strongly_not_recommend']
            }
        },
        meetingLink: String,
        location: String
    }],
    timeline: [{
        action: {
            type: String,
            required: true
        },
        performedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        performedAt: {
            type: Date,
            default: Date.now
        },
        notes: String,
        previousStatus: String,
        newStatus: String
    }],
    feedback: {
        recruiterNotes: String,
        internalNotes: String, // Not visible to candidate
        rating: {
            type: Number,
            min: 1,
            max: 5
        },
        tags: [String]
    },
    communication: [{
        type: {
            type: String,
            enum: ['email', 'phone', 'message', 'interview_invite'],
            required: true
        },
        subject: String,
        content: String,
        sentBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        sentAt: {
            type: Date,
            default: Date.now
        },
        isRead: {
            type: Boolean,
            default: false
        }
    }],
    rejectionReason: {
        category: {
            type: String,
            enum: [
                'qualifications',
                'experience',
                'skills',
                'cultural_fit',
                'salary_expectations',
                'availability',
                'interview_performance',
                'other'
            ]
        },
        details: String,
        feedback: String // Feedback to share with candidate
    }
}, {
    timestamps: true
});

// Compound indexes
applicationSchema.index({ jobDescriptionId: 1, candidateId: 1 }, { unique: true });
applicationSchema.index({ candidateId: 1, appliedAt: -1 });
applicationSchema.index({ jobDescriptionId: 1, status: 1 });
applicationSchema.index({ status: 1, appliedAt: -1 });
applicationSchema.index({ appliedAt: -1 });

// Virtual for days since application
applicationSchema.virtual('daysSinceApplication').get(function () {
    const now = new Date();
    const diffTime = now - this.appliedAt;
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
});

// Pre-save middleware to add timeline entry when status changes
applicationSchema.pre('save', function (next) {
    if (this.isModified('status') && !this.isNew) {
        this.timeline.push({
            action: `Status changed to ${this.status}`,
            previousStatus: this.constructor.findOne({ _id: this._id }).status,
            newStatus: this.status,
            performedAt: new Date()
        });
    }
    next();
});

// Instance method to update status with timeline
applicationSchema.methods.updateStatus = function (newStatus, performedBy, notes) {
    const previousStatus = this.status;
    this.status = newStatus;

    this.timeline.push({
        action: `Status changed from ${previousStatus} to ${newStatus}`,
        performedBy,
        performedAt: new Date(),
        notes,
        previousStatus,
        newStatus
    });

    return this.save();
};

// Instance method to schedule interview
applicationSchema.methods.scheduleInterview = function (interviewData) {
    this.interviews.push(interviewData);

    this.timeline.push({
        action: `Interview scheduled for ${interviewData.scheduledAt}`,
        performedBy: interviewData.interviewer,
        performedAt: new Date()
    });

    if (this.status === 'submitted' || this.status === 'under_review') {
        this.status = 'interview_scheduled';
    }

    return this.save();
};

// Instance method to add communication
applicationSchema.methods.addCommunication = function (communicationData) {
    this.communication.push(communicationData);

    this.timeline.push({
        action: `${communicationData.type} sent: ${communicationData.subject}`,
        performedBy: communicationData.sentBy,
        performedAt: new Date()
    });

    return this.save();
};

// Static method to find applications by status
applicationSchema.statics.findByStatus = function (status) {
    return this.find({ status }).populate('candidateId jobDescriptionId');
};

// Static method to find applications for a job
applicationSchema.statics.findByJob = function (jobDescriptionId) {
    return this.find({ jobDescriptionId }).populate('candidateId');
};

// Static method to get application statistics
applicationSchema.statics.getStatistics = function (jobDescriptionId) {
    return this.aggregate([
        { $match: { jobDescriptionId: mongoose.Types.ObjectId(jobDescriptionId) } },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);
};

module.exports = (connection) => {
    return connection.model('Application', applicationSchema);
};