import 'dotenv/config';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { connectToDatabase, closeDatabase } from '../src/config/db.js';

const TUITIONS_COLLECTION = 'tuitions';
const USERS_COLLECTION = 'user';
const SEED_NAMESPACE = 'mentorlagbe:tuition-seed:v1';
const EXPECTED_SEED_COUNT = 12;

const ALLOWED_ENVIRONMENTS = new Set(['development', 'test']);
const FORBIDDEN_DATABASES = new Set(['admin', 'local', 'config']);
const MODES = new Set(['Online', 'Offline']);

/**
 * Realistic tuition listings. Tutor identity is assigned at runtime from
 * existing `user` documents with role "tutor"; none of these definitions
 * contains a tutor name, email, or id.
 */
const TUITION_SEEDS = [
  {
    key: 'hsc-higher-math-dhanmondi',
    title: 'HSC Higher Mathematics Batch',
    subject: 'Higher Mathematics',
    classLevel: 'HSC',
    mode: 'Offline',
    location: 'Dhanmondi, Dhaka',
    monthlyFee: 3500,
    daysPerWeek: 3,
    bannerImage: 'https://picsum.photos/seed/ml-higher-math-dhanmondi/1200/675',
    description:
      'Focused HSC higher mathematics batch covering calculus, algebra, and coordinate geometry with weekly model tests and board-question practice.',
    createdAt: '2026-11-10T09:00:00.000Z',
  },
  {
    key: 'hsc-physics-uttara',
    title: 'HSC Physics Concept Batch',
    subject: 'Physics',
    classLevel: 'HSC',
    mode: 'Online',
    location: 'Uttara, Dhaka',
    monthlyFee: 3000,
    daysPerWeek: 4,
    bannerImage: 'https://picsum.photos/seed/ml-hsc-physics-uttara/1200/675',
    description:
      'Live online physics classes for HSC students with concept-first teaching, numerical problem solving, and recorded revision materials.',
    createdAt: '2026-11-08T10:30:00.000Z',
  },
  {
    key: 'class-8-english-mirpur',
    title: 'Class 8 English Grammar and Writing',
    subject: 'English',
    classLevel: 'Class 8',
    mode: 'Online',
    location: 'Mirpur, Dhaka',
    monthlyFee: 2000,
    daysPerWeek: 2,
    bannerImage: 'https://picsum.photos/seed/ml-class8-english-mirpur/1200/675',
    description:
      'Grammar foundations, sentence transformation, paragraph writing, and reading comprehension practice for class 8 students.',
    createdAt: '2026-11-05T08:15:00.000Z',
  },
  {
    key: 'ssc-chemistry-chattogram',
    title: 'SSC Chemistry Complete Syllabus',
    subject: 'Chemistry',
    classLevel: 'SSC',
    mode: 'Offline',
    location: 'Nasirabad, Chattogram',
    monthlyFee: 2800,
    daysPerWeek: 3,
    bannerImage: 'https://picsum.photos/seed/ml-ssc-chemistry-chattogram/1200/675',
    description:
      'Complete SSC chemistry coverage with lab-oriented explanations, chemical equation practice, and chapter-wise revision tests.',
    createdAt: '2026-11-02T12:00:00.000Z',
  },
  {
    key: 'class-9-ict-sylhet',
    title: 'Class 9 ICT Skills Program',
    subject: 'ICT',
    classLevel: 'Class 9',
    mode: 'Online',
    location: 'Zindabazar, Sylhet',
    monthlyFee: 1800,
    daysPerWeek: 2,
    bannerImage: 'https://picsum.photos/seed/ml-class9-ict-sylhet/1200/675',
    description:
      'Practical ICT lessons covering spreadsheets, presentation design, internet safety, and the class 9 board syllabus.',
    createdAt: '2026-10-29T09:45:00.000Z',
  },
  {
    key: 'medical-admission-biology-rajshahi',
    title: 'Medical Admission Biology Intensive',
    subject: 'Biology',
    classLevel: 'Admission',
    mode: 'Offline',
    location: 'Shaheb Bazar, Rajshahi',
    monthlyFee: 5000,
    daysPerWeek: 5,
    bannerImage: 'https://picsum.photos/seed/ml-medical-biology-rajshahi/1200/675',
    description:
      'Intensive medical admission biology preparation with MCQ drills, diagram practice, and weekly full-syllabus assessments.',
    createdAt: '2026-10-25T11:20:00.000Z',
  },
  {
    key: 'class-10-bangla-khulna',
    title: 'Class 10 Bangla Literature Lessons',
    subject: 'Bangla',
    classLevel: 'Class 10',
    mode: 'Online',
    location: 'Sonadanga, Khulna',
    monthlyFee: 1600,
    daysPerWeek: 2,
    bannerImage: 'https://picsum.photos/seed/ml-class10-bangla-khulna/1200/675',
    description:
      'Guided study of class 10 Bangla prose and poetry with creative writing support and exam-focused question analysis.',
    createdAt: '2026-10-20T14:00:00.000Z',
  },
  {
    key: 'hsc-accounting-barishal',
    title: 'HSC Accounting Principles Batch',
    subject: 'Accounting',
    classLevel: 'HSC',
    mode: 'Offline',
    location: 'Band Road, Barishal',
    monthlyFee: 2500,
    daysPerWeek: 3,
    bannerImage: 'https://picsum.photos/seed/ml-hsc-accounting-barishal/1200/675',
    description:
      'Step-by-step accounting principles for HSC students, including journal entries, ledgers, and financial statement practice.',
    createdAt: '2026-10-15T07:30:00.000Z',
  },
  {
    key: 'class-6-science-rangpur',
    title: 'Class 6 General Science Foundations',
    subject: 'General Science',
    classLevel: 'Class 6',
    mode: 'Online',
    location: 'Dhap Bazar, Rangpur',
    monthlyFee: 1400,
    daysPerWeek: 2,
    bannerImage: 'https://picsum.photos/seed/ml-class6-science-rangpur/1200/675',
    description:
      'Friendly introductory science classes for class 6 students with demonstrations, quizzes, and simple experiment explanations.',
    createdAt: '2026-10-10T16:10:00.000Z',
  },
  {
    key: 'ielts-speaking-mymensingh',
    title: 'IELTS Speaking and Writing Preparation',
    subject: 'English',
    classLevel: 'HSC',
    mode: 'Online',
    location: 'Ganginarpar, Mymensingh',
    monthlyFee: 4500,
    daysPerWeek: 3,
    bannerImage: 'https://picsum.photos/seed/ml-ielts-mymensingh/1200/675',
    description:
      'IELTS preparation with speaking simulations, task 2 essay feedback, vocabulary building, and weekly band-score assessments.',
    createdAt: '2026-10-05T10:00:00.000Z',
  },
  {
    key: 'math-olympiad-cumilla',
    title: 'Math Olympiad Problem Solving Club',
    subject: 'Mathematics',
    classLevel: 'Class 7',
    mode: 'Offline',
    location: 'Kandirpar, Cumilla',
    monthlyFee: 2200,
    daysPerWeek: 2,
    bannerImage: 'https://picsum.photos/seed/ml-math-olympiad-cumilla/1200/675',
    description:
      'Olympiad-style mathematics practice focused on number theory, geometry, and logical reasoning with weekly problem sets.',
    createdAt: '2026-09-28T13:30:00.000Z',
  },
  {
    key: 'admission-physics-math-gazipur',
    title: 'Engineering Admission Physics and Math',
    subject: 'Physics',
    classLevel: 'Admission',
    mode: 'Online',
    location: 'Board Bazar, Gazipur',
    monthlyFee: 6000,
    daysPerWeek: 6,
    bannerImage: 'https://picsum.photos/seed/ml-admission-gazipur/1200/675',
    description:
      'Engineering admission preparation combining physics and mathematics with daily problem solving and timed mock exams.',
    createdAt: '2026-09-20T09:00:00.000Z',
  },
];

function printUsage(message) {
  if (message) {
    console.error(message);
  }

  console.error(
    'Usage: npm run seed:tuitions -- --confirm --allow-database <database-name>'
  );
  console.error(
    'NODE_ENV must be "development" or "test", and <database-name> must exactly match the configured database.'
  );
}

function parseArguments(argv) {
  const options = {
    confirm: false,
    allowDatabase: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--confirm') {
      options.confirm = true;
    } else if (argument === '--allow-database') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        return { error: 'Missing value for --allow-database' };
      }

      options.allowDatabase = value;
      index += 1;
    } else if (argument.startsWith('--allow-database=')) {
      options.allowDatabase = argument.slice('--allow-database='.length) || null;
    } else {
      return { error: `Unknown argument: ${argument}` };
    }
  }

  return { options };
}

function seedObjectId(key) {
  const bytes = createHash('sha256')
    .update(`${SEED_NAMESPACE}:${key}`)
    .digest()
    .subarray(0, 12);

  return new ObjectId(bytes);
}

function isValidTutor(document) {
  return (
    document?._id instanceof ObjectId &&
    typeof document.name === 'string' &&
    document.name.trim() !== '' &&
    typeof document.email === 'string' &&
    document.email.trim() !== ''
  );
}

function buildSeedDocument(seed, tutor) {
  return {
    _id: seedObjectId(seed.key),
    title: seed.title,
    subject: seed.subject,
    classLevel: seed.classLevel,
    mode: seed.mode,
    location: seed.location,
    monthlyFee: seed.monthlyFee,
    daysPerWeek: seed.daysPerWeek,
    bannerImage: seed.bannerImage,
    description: seed.description,
    tutorId: tutor._id,
    tutorName: tutor.name,
    tutorEmail: tutor.email,
    approvalStatus: 'approved',
    isActive: true,
    createdAt: new Date(seed.createdAt),
  };
}

function validateSeedDocument(document) {
  const problems = [];
  const isText = (value, min, max) =>
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max;

  if (!(document._id instanceof ObjectId)) problems.push('_id');
  if (!isText(document.title, 5, 150)) problems.push('title');
  if (!isText(document.subject, 2, 80)) problems.push('subject');
  if (!isText(document.classLevel, 1, 50)) problems.push('classLevel');
  if (!MODES.has(document.mode)) problems.push('mode');
  if (!isText(document.location, 2, 120)) problems.push('location');
  if (
    typeof document.monthlyFee !== 'number' ||
    !Number.isFinite(document.monthlyFee) ||
    document.monthlyFee < 0 ||
    document.monthlyFee > 1000000
  ) {
    problems.push('monthlyFee');
  }
  if (
    !Number.isInteger(document.daysPerWeek) ||
    document.daysPerWeek < 1 ||
    document.daysPerWeek > 7
  ) {
    problems.push('daysPerWeek');
  }
  if (!isText(document.bannerImage, 1, 2048)) {
    problems.push('bannerImage');
  } else {
    try {
      const url = new URL(document.bannerImage);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push('bannerImage');
      }
    } catch {
      problems.push('bannerImage');
    }
  }
  if (!isText(document.description, 10, 2000)) problems.push('description');
  if (!(document.tutorId instanceof ObjectId)) problems.push('tutorId');
  if (!isText(document.tutorName, 1, 100)) problems.push('tutorName');
  if (!isText(document.tutorEmail, 3, 254)) problems.push('tutorEmail');
  if (document.approvalStatus !== 'approved') problems.push('approvalStatus');
  if (document.isActive !== true) problems.push('isActive');
  if (
    !(document.createdAt instanceof Date) ||
    Number.isNaN(document.createdAt.getTime())
  ) {
    problems.push('createdAt');
  }

  return problems;
}

function sanitizeErrorMessage(error) {
  const message =
    typeof error?.message === 'string' ? error.message : 'Unknown error';

  return message
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, '[redacted-mongodb-uri]')
    .split(process.env.MONGODB_URI || '\u0000')
    .join('[redacted-mongodb-uri]');
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.error) {
    printUsage(parsed.error);
    return 1;
  }

  const { options } = parsed;

  if (!options.confirm) {
    printUsage('Refusing to seed: pass --confirm to write tuition data.');
    return 1;
  }

  if (!options.allowDatabase) {
    printUsage('Refusing to seed: --allow-database is required.');
    return 1;
  }

  if (!ALLOWED_ENVIRONMENTS.has(process.env.NODE_ENV)) {
    printUsage(
      'Refusing to seed: NODE_ENV must be "development" or "test"; production is blocked.'
    );
    return 1;
  }

  let db;

  try {
    db = await connectToDatabase();
  } catch {
    console.error(
      'Seed failed: unable to connect to MongoDB. Check the MongoDB configuration.'
    );
    return 1;
  }

  try {
    const databaseName = db.databaseName;

    console.log('MentorLagbe tuition seed');
    console.log(`Database: ${databaseName}`);

    if (
      FORBIDDEN_DATABASES.has(databaseName) ||
      /prod/i.test(databaseName)
    ) {
      console.error(
        'Refusing to seed: the configured database name looks like a protected or production database.'
      );
      return 1;
    }

    if (options.allowDatabase !== databaseName) {
      console.error(
        'Refusing to seed: --allow-database must exactly match the configured database name.'
      );
      return 1;
    }

    const tutorDocuments = await db
      .collection(USERS_COLLECTION)
      .find(
        { role: 'tutor' },
        { projection: { name: 1, email: 1, role: 1 } }
      )
      .sort({ _id: 1 })
      .toArray();

    const validTutors = tutorDocuments.filter(isValidTutor);
    const invalidTutorCount = tutorDocuments.length - validTutors.length;

    console.log(
      `Tutor profiles: ${validTutors.length} valid, ${invalidTutorCount} invalid (skipped)`
    );

    if (validTutors.length === 0) {
      console.error(
        'Refusing to seed: no valid tutor profiles found. Create at least one user with role "tutor" (with a name and email) before seeding.'
      );
      return 1;
    }

    if (TUITION_SEEDS.length !== EXPECTED_SEED_COUNT) {
      console.error(
        `Refusing to seed: expected ${EXPECTED_SEED_COUNT} tuition definitions but found ${TUITION_SEEDS.length}.`
      );
      return 1;
    }

    const documents = TUITION_SEEDS.map((seed, index) =>
      buildSeedDocument(seed, validTutors[index % validTutors.length])
    );

    const problems = documents.flatMap((document) =>
      validateSeedDocument(document).map(
        (field) => `${document.title || 'unknown'}: ${field}`
      )
    );

    if (problems.length > 0) {
      console.error(
        `Refusing to seed: ${problems.length} invalid seed field(s) detected: ${problems.join(', ')}`
      );
      return 1;
    }

    const collection = db.collection(TUITIONS_COLLECTION);

    // Deterministic _id values make repeat runs idempotent. $setOnInsert never
    // modifies an existing tuition document, including unrelated records.
    const result = await collection.bulkWrite(
      documents.map((document) => ({
        updateOne: {
          filter: { _id: document._id },
          update: { $setOnInsert: document },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    const inserted = result.upsertedCount ?? 0;
    const alreadyPresent = documents.length - inserted;
    const seededTotal = await collection.countDocuments({
      _id: { $in: documents.map((document) => document._id) },
    });

    console.log(
      `Tuitions: ${seededTotal} seeded in total (${inserted} inserted, ${alreadyPresent} already present)`
    );

    return 0;
  } catch (error) {
    console.error(`Seed failed: ${sanitizeErrorMessage(error)}`);
    return 1;
  } finally {
    await closeDatabase().catch(() => {});
  }
}

const exitCode = await main();
process.exit(exitCode);
