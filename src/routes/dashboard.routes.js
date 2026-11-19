import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import { verifyToken } from '../middleware/auth.middleware.js';

const USERS_COLLECTION = 'user';
const TUITIONS_COLLECTION = 'tuitions';
const APPLICATIONS_COLLECTION = 'applications';
const PAYMENTS_COLLECTION = 'payments';

const SUPPORTED_ROLES = new Set(['student', 'tutor', 'admin']);
const RECENT_LIMIT = 5;

const STUDENT_APPLICATION_PROJECTION = {
  tuitionId: 1,
  tuitionTitle: 1,
  subject: 1,
  monthlyFee: 1,
  status: 1,
  appliedAt: 1,
};

const TUTOR_APPLICATION_PROJECTION = {
  ...STUDENT_APPLICATION_PROJECTION,
  studentName: 1,
  studentEmail: 1,
  studentPhone: 1,
  preferredSchedule: 1,
  studentNote: 1,
};

const RECENT_USER_PROJECTION = {
  name: 1,
  email: 1,
  role: 1,
  plan: 1,
  createdAt: 1,
};

const RECENT_TUITION_PROJECTION = {
  title: 1,
  subject: 1,
  classLevel: 1,
  mode: 1,
  monthlyFee: 1,
  tutorName: 1,
  tutorEmail: 1,
  approvalStatus: 1,
  isActive: 1,
  createdAt: 1,
};

const RECENT_APPLICATION_PROJECTION = {
  tuitionId: 1,
  tuitionTitle: 1,
  subject: 1,
  studentName: 1,
  studentEmail: 1,
  status: 1,
  appliedAt: 1,
};

const RECENT_PAYMENT_PROJECTION = {
  userEmail: 1,
  userName: 1,
  userRole: 1,
  planName: 1,
  amount: 1,
  currency: 1,
  paymentStatus: 1,
  paidAt: 1,
};

const router = Router();

function usersCollection() {
  return getDb().collection(USERS_COLLECTION);
}

function tuitionsCollection() {
  return getDb().collection(TUITIONS_COLLECTION);
}

function applicationsCollection() {
  return getDb().collection(APPLICATIONS_COLLECTION);
}

function paymentsCollection() {
  return getDb().collection(PAYMENTS_COLLECTION);
}

function toObjectId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

/**
 * Groups tuition documents by approval status and counts active records in a
 * single server-side aggregation.
 */
async function summarizeTuitions(filter) {
  const rows = await tuitionsCollection()
    .aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$approvalStatus',
          count: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } },
        },
      },
    ])
    .toArray();

  const summary = {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    active: 0,
  };

  for (const row of rows) {
    summary.total += row.count;
    summary.active += row.active;

    if (row._id === 'pending') {
      summary.pending = row.count;
    } else if (row._id === 'approved') {
      summary.approved = row.count;
    } else if (row._id === 'rejected') {
      summary.rejected = row.count;
    }
  }

  return summary;
}

/**
 * Groups application documents by status for the given ownership filter.
 */
async function summarizeApplications(filter) {
  const rows = await applicationsCollection()
    .aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    .toArray();

  const summary = {
    total: 0,
    pending: 0,
    accepted: 0,
    rejected: 0,
  };

  for (const row of rows) {
    summary.total += row.count;

    if (row._id === 'pending') {
      summary.pending = row.count;
    } else if (row._id === 'accepted') {
      summary.accepted = row.count;
    } else if (row._id === 'rejected') {
      summary.rejected = row.count;
    }
  }

  return summary;
}

async function summarizeUsers() {
  const rows = await usersCollection()
    .aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }])
    .toArray();

  const summary = {
    total: 0,
    students: 0,
    tutors: 0,
    admins: 0,
  };

  for (const row of rows) {
    summary.total += row.count;

    if (row._id === 'student') {
      summary.students = row.count;
    } else if (row._id === 'tutor') {
      summary.tutors = row.count;
    } else if (row._id === 'admin') {
      summary.admins = row.count;
    }
  }

  return summary;
}

/**
 * Counts verified paid payments and sums the stored USD amount.
 */
async function summarizePayments() {
  const [row] = await paymentsCollection()
    .aggregate([
      { $match: { paymentStatus: 'paid' } },
      {
        $group: {
          _id: null,
          totalPayments: { $sum: 1 },
          totalRevenue: { $sum: '$amount' },
        },
      },
    ])
    .toArray();

  return {
    totalPayments: row?.totalPayments ?? 0,
    totalRevenue:
      Math.round(((row?.totalRevenue ?? 0) + Number.EPSILON) * 100) / 100,
  };
}

function toRecentStudentApplication(document) {
  return {
    id: document._id.toString(),
    tuitionId: document.tuitionId ? document.tuitionId.toString() : null,
    tuitionTitle: document.tuitionTitle,
    subject: document.subject,
    monthlyFee: document.monthlyFee,
    status: document.status,
    appliedAt: document.appliedAt ?? null,
  };
}

function toRecentTutorApplication(document) {
  return {
    ...toRecentStudentApplication(document),
    studentName: document.studentName,
    studentEmail: document.studentEmail,
    studentPhone: document.studentPhone,
    preferredSchedule: document.preferredSchedule,
    studentNote: document.studentNote ?? null,
  };
}

function toRecentAdminApplication(document) {
  return {
    id: document._id.toString(),
    tuitionId: document.tuitionId ? document.tuitionId.toString() : null,
    tuitionTitle: document.tuitionTitle,
    subject: document.subject,
    studentName: document.studentName,
    studentEmail: document.studentEmail,
    status: document.status,
    appliedAt: document.appliedAt ?? null,
  };
}

function toRecentUser(document) {
  return {
    id: document._id.toString(),
    name: document.name,
    email: document.email,
    role: document.role,
    plan: document.plan ?? 'free',
    createdAt: document.createdAt ?? null,
  };
}

function toRecentTuition(document) {
  return {
    id: document._id.toString(),
    title: document.title,
    subject: document.subject,
    classLevel: document.classLevel,
    mode: document.mode,
    monthlyFee: document.monthlyFee,
    tutorName: document.tutorName,
    tutorEmail: document.tutorEmail,
    approvalStatus: document.approvalStatus,
    isActive: document.isActive,
    createdAt: document.createdAt ?? null,
  };
}

function toRecentPayment(document) {
  return {
    id: document._id.toString(),
    userEmail: document.userEmail,
    userName: document.userName,
    userRole: document.userRole,
    planName: document.planName,
    amount: document.amount,
    currency: document.currency,
    paymentStatus: document.paymentStatus,
    paidAt: document.paidAt ?? null,
  };
}

async function buildStudentOverview(userId) {
  const [applications, recentApplications] = await Promise.all([
    summarizeApplications({ studentId: userId }),
    applicationsCollection()
      .find({ studentId: userId }, { projection: STUDENT_APPLICATION_PROJECTION })
      .sort({ appliedAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),
  ]);

  return {
    stats: {
      totalApplications: applications.total,
      pendingApplications: applications.pending,
      acceptedApplications: applications.accepted,
      rejectedApplications: applications.rejected,
    },
    recentActivity: {
      applications: recentApplications.map(toRecentStudentApplication),
    },
  };
}

async function buildTutorOverview(userId) {
  const [tuitions, applications, recentApplications] = await Promise.all([
    summarizeTuitions({ tutorId: userId }),
    summarizeApplications({ tutorId: userId }),
    applicationsCollection()
      .find({ tutorId: userId }, { projection: TUTOR_APPLICATION_PROJECTION })
      .sort({ appliedAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),
  ]);

  return {
    stats: {
      totalTuitions: tuitions.total,
      pendingTuitions: tuitions.pending,
      approvedTuitions: tuitions.approved,
      rejectedTuitions: tuitions.rejected,
      activeTuitions: tuitions.active,
      totalApplications: applications.total,
      pendingApplications: applications.pending,
      acceptedApplications: applications.accepted,
      rejectedApplications: applications.rejected,
    },
    recentActivity: {
      applications: recentApplications.map(toRecentTutorApplication),
    },
  };
}

async function buildAdminOverview() {
  const [
    users,
    tuitions,
    applications,
    payments,
    recentUsers,
    recentTuitions,
    recentApplications,
    recentPayments,
  ] = await Promise.all([
    summarizeUsers(),
    summarizeTuitions({}),
    summarizeApplications({}),
    summarizePayments(),
    usersCollection()
      .find({}, { projection: RECENT_USER_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),
    tuitionsCollection()
      .find({}, { projection: RECENT_TUITION_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),
    applicationsCollection()
      .find({}, { projection: RECENT_APPLICATION_PROJECTION })
      .sort({ appliedAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),
    paymentsCollection()
      .find(
        { paymentStatus: 'paid' },
        { projection: RECENT_PAYMENT_PROJECTION }
      )
      .sort({ paidAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),
  ]);

  return {
    stats: {
      totalUsers: users.total,
      totalStudents: users.students,
      totalTutors: users.tutors,
      totalAdmins: users.admins,
      totalTuitions: tuitions.total,
      pendingTuitions: tuitions.pending,
      approvedTuitions: tuitions.approved,
      rejectedTuitions: tuitions.rejected,
      activeTuitions: tuitions.active,
      totalApplications: applications.total,
      pendingApplications: applications.pending,
      acceptedApplications: applications.accepted,
      rejectedApplications: applications.rejected,
      totalPayments: payments.totalPayments,
      totalRevenue: payments.totalRevenue,
    },
    recentActivity: {
      users: recentUsers.map(toRecentUser),
      tuitions: recentTuitions.map(toRecentTuition),
      applications: recentApplications.map(toRecentAdminApplication),
      payments: recentPayments.map(toRecentPayment),
    },
  };
}

/**
 * GET /api/dashboard/overview
 * Role-specific dashboard statistics. The role always comes from the verified
 * user document; query/body input is never used for authorization.
 */
router.get('/overview', verifyToken, async (req, res) => {
  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  const user = await usersCollection().findOne(
    { _id: userId },
    { projection: { role: 1 } }
  );

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  if (!SUPPORTED_ROLES.has(user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Unsupported account role',
    });
  }

  let overview;

  if (user.role === 'student') {
    overview = await buildStudentOverview(userId);
  } else if (user.role === 'tutor') {
    overview = await buildTutorOverview(userId);
  } else {
    overview = await buildAdminOverview();
  }

  return res.json({
    success: true,
    message: 'Dashboard overview retrieved successfully',
    role: user.role,
    data: overview,
  });
});

export default router;
