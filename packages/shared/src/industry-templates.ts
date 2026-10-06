/**
 * Industry templates (`FR-ONB-2`).
 *
 * A new workspace is provisioned with a deliberately industry-neutral vocabulary, because the
 * product has to work on first login. A template is what turns that into **this** business's
 * vocabulary: a builder's pipeline runs "Site visit → Booking", a coaching centre's runs "Demo
 * class → Enrolled", and a clinic's leads need a treatment and a preferred doctor, not a budget.
 *
 * **Why the definitions live here, in code, and the rows live in the database.** The catalogue is
 * platform reference data, exactly like `PERMISSION_CATALOGUE`: one definition, read by the seeder
 * and by the API, so the ten industries cannot drift between them. The `industry_templates` table
 * exists so an organization can **record which one it applied** (and so the Super Admin console can
 * eventually edit one without a deploy) — not as a second source of truth.
 *
 * **What a template is not.** It is not a special mode. Everything it writes is an ordinary row a
 * business can rename, reorder, deactivate or delete five minutes later; nothing in the product ever
 * checks which template a workspace chose. That is rule 4, and it is the reason a template can be
 * wrong about an industry without being a problem.
 */

export interface TemplateStatus {
  readonly name: string;
  readonly category: 'open' | 'won' | 'lost' | 'invalid';
  readonly colour: string;
  readonly isDefault?: boolean;
}

export interface TemplateStage {
  readonly name: string;
  readonly colour: string;
  readonly probability: number;
  readonly isWon?: boolean;
  readonly isLost?: boolean;
}

export interface TemplateSource {
  readonly name: string;
  readonly type: string;
  readonly costModel: string;
}

export interface TemplateField {
  readonly entityType: 'lead' | 'customer' | 'deal';
  readonly key: string;
  readonly label: string;
  readonly type:
    | 'text'
    | 'textarea'
    | 'number'
    | 'decimal'
    | 'currency'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'select'
    | 'multiselect'
    | 'phone'
    | 'email'
    | 'url'
    | 'rating';
  readonly helpText?: string;
  readonly options?: readonly string[];
  readonly showInList?: boolean;
  readonly isRequired?: boolean;
}

export interface TemplateView {
  readonly name: string;
  readonly description: string;
  readonly filters: Record<string, unknown>;
}

export interface IndustryTemplate {
  readonly key: string;
  readonly name: string;
  /** One sentence, shown on the picker. Written for a business owner, not for a developer. */
  readonly description: string;
  readonly statuses: readonly TemplateStatus[];
  readonly stages: readonly TemplateStage[];
  readonly sources: readonly TemplateSource[];
  readonly lostReasons: readonly { name: string; requiresNote?: boolean }[];
  readonly tags: readonly { name: string; colour: string }[];
  readonly fields: readonly TemplateField[];
  readonly views: readonly TemplateView[];
}

// ── Shared pieces ───────────────────────────────────────────────────────────
//
// Every business has a "New" and a "Lost"; what differs is the middle. Sharing the ends keeps the
// ten definitions about what is actually different, which is also what makes them readable.

const TERMINAL_STATUSES: readonly TemplateStatus[] = [
  { name: 'Won', category: 'won', colour: '#2f9e44' },
  { name: 'Lost', category: 'lost', colour: '#e03131' },
  { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
];

const TERMINAL_STAGES: readonly TemplateStage[] = [
  { name: 'Won', colour: '#2f9e44', probability: 100, isWon: true },
  { name: 'Lost', colour: '#e03131', probability: 0, isLost: true },
];

const COMMON_SOURCES: readonly TemplateSource[] = [
  { name: 'Website form', type: 'organic', costModel: 'none' },
  { name: 'Google Ads', type: 'paid', costModel: 'per_click' },
  { name: 'Facebook Ads', type: 'paid', costModel: 'per_click' },
  { name: 'Instagram', type: 'paid', costModel: 'per_click' },
  { name: 'WhatsApp', type: 'direct', costModel: 'none' },
  { name: 'Phone call', type: 'direct', costModel: 'none' },
  { name: 'Referral', type: 'referral', costModel: 'none' },
  { name: 'Walk-in', type: 'offline', costModel: 'none' },
];

const COMMON_LOST_REASONS: readonly { name: string; requiresNote?: boolean }[] = [
  { name: 'Price too high' },
  { name: 'Went with someone else', requiresNote: true },
  { name: 'Not the right time' },
  { name: 'No response after follow-ups' },
  { name: 'Wrong or unreachable number' },
  { name: 'Other', requiresNote: true },
];

const BUDGET_FIELD: TemplateField = {
  entityType: 'lead',
  key: 'budget',
  label: 'Budget',
  type: 'currency',
  helpText: 'What they said they can spend. Filterable in minor units.',
  showInList: true,
};

/**
 * The ten industries `FR-ONB-2` names.
 *
 * Each one is a guess about a business, and a good template is one somebody changes twice rather
 * than throwing away. So: the statuses and stages are the words that trade actually uses, the
 * custom fields are the three or four things their staff ask on every call, and the saved view is
 * the list their manager opens first thing in the morning.
 */
export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  {
    key: 'real_estate',
    name: 'Real estate',
    description:
      'Flats, plots and commercial space. Site visits drive the pipeline, and the budget and configuration decide what is worth showing.',
    statuses: [
      { name: 'New enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Contacted', category: 'open', colour: '#1098ad' },
      { name: 'Site visit scheduled', category: 'open', colour: '#0ca678' },
      { name: 'Site visit done', category: 'open', colour: '#66a80f' },
      { name: 'Negotiating', category: 'open', colour: '#f59f00' },
      { name: 'Booked', category: 'open', colour: '#7048e8' },
      ...TERMINAL_STATUSES,
    ],
    stages: [
      { name: 'New enquiry', colour: '#3b5bdb', probability: 10 },
      { name: 'Qualified', colour: '#1098ad', probability: 25 },
      { name: 'Site visit', colour: '#0ca678', probability: 45 },
      { name: 'Revisit', colour: '#66a80f', probability: 60 },
      { name: 'Negotiation', colour: '#f59f00', probability: 80 },
      { name: 'Booking amount', colour: '#7048e8', probability: 92 },
      ...TERMINAL_STAGES,
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: '99acres / MagicBricks', type: 'paid', costModel: 'per_lead' },
      { name: 'Channel partner', type: 'referral', costModel: 'commission' },
      { name: 'Hoarding / print', type: 'offline', costModel: 'fixed' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Location did not suit' },
      { name: 'Loan not sanctioned' },
      { name: 'Possession date too far' },
    ],
    tags: [
      { name: 'Site visit done', colour: '#0ca678' },
      { name: 'Loan needed', colour: '#f59f00' },
      { name: 'NRI', colour: '#7048e8' },
      { name: 'Investor', colour: '#1098ad' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      BUDGET_FIELD,
      {
        entityType: 'lead',
        key: 'configuration',
        label: 'Configuration',
        type: 'select',
        options: ['1 BHK', '2 BHK', '3 BHK', '4 BHK+', 'Plot', 'Commercial'],
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'preferred_locality',
        label: 'Preferred locality',
        type: 'text',
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'possession_timeline',
        label: 'Possession needed by',
        type: 'select',
        options: ['Ready to move', 'Within 6 months', 'Within a year', 'Investment, no hurry'],
      },
      { entityType: 'lead', key: 'loan_required', label: 'Home loan needed', type: 'boolean' },
    ],
    views: [
      {
        name: 'Site visit due this week',
        description: 'Everyone who has agreed to a visit and not yet been.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Site visit scheduled' }],
        },
      },
      {
        name: 'Visited, not decided',
        description: 'The ones a follow-up actually closes.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Site visit done' }],
        },
      },
    ],
  },
  {
    key: 'education',
    name: 'Education & coaching',
    description:
      'Courses, batches and admissions. A demo class is the moment a parent decides, and the counsellor who took the call matters.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Counselling done', category: 'open', colour: '#1098ad' },
      { name: 'Demo scheduled', category: 'open', colour: '#0ca678' },
      { name: 'Demo attended', category: 'open', colour: '#66a80f' },
      { name: 'Fee discussion', category: 'open', colour: '#f59f00' },
      { name: 'Enrolled', category: 'won', colour: '#2f9e44' },
      { name: 'Not interested', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 10 },
      { name: 'Counselling', colour: '#1098ad', probability: 30 },
      { name: 'Demo class', colour: '#0ca678', probability: 55 },
      { name: 'Fee discussion', colour: '#f59f00', probability: 75 },
      { name: 'Enrolled', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Dropped', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'School tie-up', type: 'referral', costModel: 'commission' },
      { name: 'Seminar / open day', type: 'offline', costModel: 'fixed' },
      { name: 'Existing student referral', type: 'referral', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Fees beyond budget' },
      { name: 'Batch timing did not suit' },
      { name: 'Too far to travel' },
      { name: 'Chose online instead' },
    ],
    tags: [
      { name: 'Demo attended', colour: '#0ca678' },
      { name: 'Scholarship case', colour: '#7048e8' },
      { name: 'Repeat family', colour: '#1098ad' },
      { name: 'Instalments needed', colour: '#f59f00' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'course_interest',
        label: 'Course',
        type: 'select',
        options: ['NEET', 'JEE', 'Foundation', 'Board tuition', 'Spoken English', 'Other'],
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'student_class',
        label: 'Class / year',
        type: 'text',
        showInList: true,
      },
      { entityType: 'lead', key: 'parent_name', label: 'Parent’s name', type: 'text' },
      {
        entityType: 'lead',
        key: 'preferred_batch',
        label: 'Preferred batch',
        type: 'select',
        options: ['Morning', 'Afternoon', 'Evening', 'Weekend'],
      },
      { entityType: 'lead', key: 'demo_date', label: 'Demo class on', type: 'date' },
    ],
    views: [
      {
        name: 'Demos this week',
        description: 'Who is coming, so somebody can be ready for them.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Demo scheduled' }],
        },
      },
      {
        name: 'Attended, not enrolled',
        description: 'The single most convertible list in a coaching business.',
        filters: { conditions: [{ field: 'status.name', operator: 'eq', value: 'Demo attended' }] },
      },
    ],
  },
  {
    key: 'healthcare',
    name: 'Clinic & healthcare',
    description:
      'Appointments, treatments and follow-ups. The treatment asked about and the doctor preferred are what the front desk needs on screen.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Appointment booked', category: 'open', colour: '#1098ad' },
      { name: 'Consulted', category: 'open', colour: '#0ca678' },
      { name: 'Treatment advised', category: 'open', colour: '#f59f00' },
      { name: 'Treatment started', category: 'won', colour: '#2f9e44' },
      { name: 'Declined', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 15 },
      { name: 'Appointment', colour: '#1098ad', probability: 40 },
      { name: 'Consultation', colour: '#0ca678', probability: 60 },
      { name: 'Treatment advised', colour: '#f59f00', probability: 80 },
      { name: 'Treatment started', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Declined', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'Google Maps / local search', type: 'organic', costModel: 'none' },
      { name: 'Doctor referral', type: 'referral', costModel: 'none' },
      { name: 'Health camp', type: 'offline', costModel: 'fixed' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Cost of treatment' },
      { name: 'Wanted a second opinion' },
      { name: 'Insurance not accepted' },
      { name: 'Travelling / out of town' },
    ],
    tags: [
      { name: 'Insurance case', colour: '#1098ad' },
      { name: 'Follow-up due', colour: '#f59f00' },
      { name: 'Senior citizen', colour: '#7048e8' },
      { name: 'Package enquiry', colour: '#0ca678' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'treatment_interest',
        label: 'Treatment',
        type: 'text',
        showInList: true,
      },
      { entityType: 'lead', key: 'preferred_doctor', label: 'Preferred doctor', type: 'text' },
      { entityType: 'lead', key: 'appointment_at', label: 'Appointment', type: 'datetime' },
      {
        entityType: 'lead',
        key: 'insurance_provider',
        label: 'Insurance',
        type: 'text',
        helpText: 'Leave blank for a self-paying patient.',
      },
    ],
    views: [
      {
        name: 'Appointments to confirm',
        description: 'Booked and not yet reminded.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Appointment booked' }],
        },
      },
      {
        name: 'Advised, not started',
        description:
          'Treatment recommended and not yet begun — the follow-up that pays for itself.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Treatment advised' }],
        },
      },
    ],
  },
  {
    key: 'automobile',
    name: 'Automobile',
    description:
      'Cars and two-wheelers. A test drive is the pipeline, and the exchange and finance questions decide the deal.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Contacted', category: 'open', colour: '#1098ad' },
      { name: 'Test drive scheduled', category: 'open', colour: '#0ca678' },
      { name: 'Test drive done', category: 'open', colour: '#66a80f' },
      { name: 'Quotation given', category: 'open', colour: '#f59f00' },
      { name: 'Booked', category: 'won', colour: '#2f9e44' },
      { name: 'Lost', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 10 },
      { name: 'Test drive', colour: '#0ca678', probability: 40 },
      { name: 'Quotation', colour: '#f59f00', probability: 65 },
      { name: 'Finance / exchange', colour: '#7048e8', probability: 80 },
      { name: 'Booked', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Lost', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'Showroom walk-in', type: 'offline', costModel: 'none' },
      { name: 'CarDekho / OLX', type: 'paid', costModel: 'per_lead' },
      { name: 'Service customer', type: 'internal', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Bought a different brand' },
      { name: 'Finance rejected' },
      { name: 'Waiting period too long' },
      { name: 'Exchange value too low' },
    ],
    tags: [
      { name: 'Test drive done', colour: '#0ca678' },
      { name: 'Exchange', colour: '#f59f00' },
      { name: 'Finance needed', colour: '#7048e8' },
      { name: 'Corporate', colour: '#1098ad' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      { entityType: 'lead', key: 'model_interest', label: 'Model', type: 'text', showInList: true },
      {
        entityType: 'lead',
        key: 'variant',
        label: 'Variant',
        type: 'select',
        options: ['Base', 'Mid', 'Top', 'Not decided'],
      },
      { entityType: 'lead', key: 'exchange_vehicle', label: 'Exchange vehicle', type: 'text' },
      { entityType: 'lead', key: 'finance_required', label: 'Finance needed', type: 'boolean' },
      { entityType: 'lead', key: 'test_drive_at', label: 'Test drive', type: 'datetime' },
    ],
    views: [
      {
        name: 'Test drives this week',
        description: 'Who is coming in, and for which model.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Test drive scheduled' }],
        },
      },
      {
        name: 'Quoted, not booked',
        description: 'A price is out and no decision yet.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Quotation given' }],
        },
      },
    ],
  },
  {
    key: 'ecommerce',
    name: 'E-commerce & retail',
    description:
      'Orders, carts and repeat buyers. Most of the pipeline is short, so what matters is the abandoned cart and the order value.',
    statuses: [
      { name: 'New', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Cart abandoned', category: 'open', colour: '#f59f00' },
      { name: 'Enquiry on WhatsApp', category: 'open', colour: '#0ca678' },
      { name: 'Order placed', category: 'won', colour: '#2f9e44' },
      { name: 'Did not buy', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Interested', colour: '#3b5bdb', probability: 20 },
      { name: 'Cart / quote', colour: '#f59f00', probability: 45 },
      { name: 'Payment pending', colour: '#7048e8', probability: 75 },
      { name: 'Ordered', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Dropped', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'Marketplace (Amazon / Flipkart)', type: 'paid', costModel: 'commission' },
      { name: 'Influencer', type: 'paid', costModel: 'fixed' },
      { name: 'Email campaign', type: 'owned', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Found it cheaper elsewhere' },
      { name: 'Delivery time too long' },
      { name: 'Out of stock' },
      { name: 'Payment failed' },
    ],
    tags: [
      { name: 'Repeat buyer', colour: '#0ca678' },
      { name: 'High value', colour: '#7048e8' },
      { name: 'COD only', colour: '#f59f00' },
      { name: 'Cart abandoned', colour: '#e8590c' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'product_interest',
        label: 'Product',
        type: 'text',
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'cart_value',
        label: 'Cart value',
        type: 'currency',
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'preferred_payment',
        label: 'Preferred payment',
        type: 'select',
        options: ['UPI', 'Card', 'Cash on delivery', 'Net banking'],
      },
      { entityType: 'lead', key: 'pincode', label: 'Delivery pincode', type: 'text' },
    ],
    views: [
      {
        name: 'Abandoned carts',
        description: 'The list a single WhatsApp message recovers.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Cart abandoned' }],
        },
      },
    ],
  },
  {
    key: 'fitness',
    name: 'Gym & fitness',
    description:
      'Memberships and trials. A trial session converts or it does not, and the goal somebody states is what a trainer follows up on.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Trial booked', category: 'open', colour: '#0ca678' },
      { name: 'Trial done', category: 'open', colour: '#66a80f' },
      { name: 'Negotiating', category: 'open', colour: '#f59f00' },
      { name: 'Joined', category: 'won', colour: '#2f9e44' },
      { name: 'Not joining', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 15 },
      { name: 'Trial', colour: '#0ca678', probability: 45 },
      { name: 'Plan discussion', colour: '#f59f00', probability: 70 },
      { name: 'Joined', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Dropped', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'Google Maps / local search', type: 'organic', costModel: 'none' },
      { name: 'Member referral', type: 'referral', costModel: 'none' },
      { name: 'Corporate tie-up', type: 'referral', costModel: 'commission' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Joined a gym closer to home' },
      { name: 'Timings did not suit' },
      { name: 'Wanted a shorter plan' },
    ],
    tags: [
      { name: 'Trial done', colour: '#0ca678' },
      { name: 'Personal training', colour: '#7048e8' },
      { name: 'Corporate', colour: '#1098ad' },
      { name: 'Renewal due', colour: '#f59f00' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'goal',
        label: 'Goal',
        type: 'select',
        options: ['Weight loss', 'Muscle gain', 'General fitness', 'Rehab', 'Sport-specific'],
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'plan_interest',
        label: 'Plan',
        type: 'select',
        options: ['Monthly', 'Quarterly', 'Half-yearly', 'Annual'],
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'preferred_time',
        label: 'Preferred time',
        type: 'select',
        options: ['Early morning', 'Morning', 'Evening', 'Late evening'],
      },
      { entityType: 'lead', key: 'trial_at', label: 'Trial session', type: 'datetime' },
    ],
    views: [
      {
        name: 'Trials this week',
        description: 'Who is coming in to try.',
        filters: { conditions: [{ field: 'status.name', operator: 'eq', value: 'Trial booked' }] },
      },
      {
        name: 'Tried, not joined',
        description: 'They have already walked in once.',
        filters: { conditions: [{ field: 'status.name', operator: 'eq', value: 'Trial done' }] },
      },
    ],
  },
  {
    key: 'salon',
    name: 'Salon & spa',
    description:
      'Appointments and packages. The service asked for and the stylist preferred are the whole conversation.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Appointment booked', category: 'open', colour: '#0ca678' },
      { name: 'Visited', category: 'won', colour: '#2f9e44' },
      { name: 'No show', category: 'lost', colour: '#e8590c' },
      { name: 'Not interested', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 20 },
      { name: 'Appointment', colour: '#0ca678', probability: 60 },
      { name: 'Package discussion', colour: '#f59f00', probability: 80 },
      { name: 'Booked', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Lost', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'Google Maps / local search', type: 'organic', costModel: 'none' },
      { name: 'Urban Company / aggregator', type: 'paid', costModel: 'commission' },
      { name: 'Client referral', type: 'referral', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Slot not available' },
      { name: 'Preferred stylist unavailable' },
      { name: 'Too far to travel' },
    ],
    tags: [
      { name: 'Package client', colour: '#7048e8' },
      { name: 'Bridal', colour: '#f783ac' },
      { name: 'Regular', colour: '#0ca678' },
      { name: 'No show', colour: '#e8590c' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'service_interest',
        label: 'Service',
        type: 'multiselect',
        options: ['Hair', 'Skin', 'Nails', 'Bridal', 'Spa', 'Grooming'],
        showInList: true,
      },
      { entityType: 'lead', key: 'preferred_stylist', label: 'Preferred stylist', type: 'text' },
      { entityType: 'lead', key: 'appointment_at', label: 'Appointment', type: 'datetime' },
      { entityType: 'lead', key: 'package_interest', label: 'Package enquiry', type: 'boolean' },
    ],
    views: [
      {
        name: 'Appointments to confirm',
        description: 'Booked and not yet reminded — which is what a no-show is.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Appointment booked' }],
        },
      },
    ],
  },
  {
    key: 'travel',
    name: 'Travel & tourism',
    description:
      'Packages and itineraries. Dates, pax and destination are the first three questions on every call.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Itinerary shared', category: 'open', colour: '#1098ad' },
      { name: 'Quotation sent', category: 'open', colour: '#f59f00' },
      { name: 'Negotiating', category: 'open', colour: '#e8590c' },
      { name: 'Booked', category: 'won', colour: '#2f9e44' },
      { name: 'Lost', category: 'lost', colour: '#e03131' },
      { name: 'Invalid number', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 10 },
      { name: 'Itinerary', colour: '#1098ad', probability: 35 },
      { name: 'Quotation', colour: '#f59f00', probability: 60 },
      { name: 'Advance pending', colour: '#7048e8', probability: 85 },
      { name: 'Booked', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Lost', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'MakeMyTrip / aggregator', type: 'paid', costModel: 'commission' },
      { name: 'Travel agent', type: 'referral', costModel: 'commission' },
      { name: 'Past traveller', type: 'internal', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Dates did not work out' },
      { name: 'Visa not granted' },
      { name: 'Booked directly with a hotel' },
      { name: 'Trip postponed' },
    ],
    tags: [
      { name: 'Honeymoon', colour: '#f783ac' },
      { name: 'Family', colour: '#1098ad' },
      { name: 'Group booking', colour: '#7048e8' },
      { name: 'Visa help needed', colour: '#f59f00' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'destination',
        label: 'Destination',
        type: 'text',
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'travel_from',
        label: 'Travelling from',
        type: 'date',
        showInList: true,
      },
      { entityType: 'lead', key: 'travel_to', label: 'Returning on', type: 'date' },
      { entityType: 'lead', key: 'pax', label: 'Travellers', type: 'number', showInList: true },
      BUDGET_FIELD,
    ],
    views: [
      {
        name: 'Quoted, waiting',
        description: 'A price is out and the dates are approaching.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Quotation sent' }],
        },
      },
    ],
  },
  {
    key: 'professional_services',
    name: 'Professional services',
    description:
      'Agencies, consultants, CAs and law firms. A scoping call and a proposal are the pipeline, and the engagement is usually retained.',
    statuses: [
      { name: 'New enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Discovery call done', category: 'open', colour: '#1098ad' },
      { name: 'Proposal sent', category: 'open', colour: '#f59f00' },
      { name: 'Negotiating', category: 'open', colour: '#e8590c' },
      { name: 'Retained', category: 'won', colour: '#2f9e44' },
      { name: 'Lost', category: 'lost', colour: '#e03131' },
      { name: 'Not a fit', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 10 },
      { name: 'Discovery', colour: '#1098ad', probability: 30 },
      { name: 'Proposal', colour: '#f59f00', probability: 55 },
      { name: 'Negotiation', colour: '#e8590c', probability: 75 },
      { name: 'Contract', colour: '#7048e8', probability: 90 },
      ...TERMINAL_STAGES,
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'LinkedIn', type: 'paid', costModel: 'per_click' },
      { name: 'Partner referral', type: 'referral', costModel: 'commission' },
      { name: 'Inbound content', type: 'organic', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Took it in-house' },
      { name: 'Scope was too large for us' },
      { name: 'Procurement stalled' },
    ],
    tags: [
      { name: 'Retainer', colour: '#0ca678' },
      { name: 'One-off project', colour: '#1098ad' },
      { name: 'Enterprise', colour: '#7048e8' },
      { name: 'Needs NDA', colour: '#f59f00' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'service_line',
        label: 'Service',
        type: 'select',
        options: ['Advisory', 'Compliance', 'Implementation', 'Retainer', 'Audit'],
        showInList: true,
      },
      {
        entityType: 'lead',
        key: 'engagement_type',
        label: 'Engagement',
        type: 'select',
        options: ['Retainer', 'Project', 'Hourly'],
        showInList: true,
      },
      BUDGET_FIELD,
      { entityType: 'lead', key: 'decision_maker', label: 'Decision maker', type: 'text' },
      { entityType: 'lead', key: 'team_size', label: 'Their team size', type: 'number' },
    ],
    views: [
      {
        name: 'Proposals out',
        description: 'Every proposal waiting for an answer.',
        filters: { conditions: [{ field: 'status.name', operator: 'eq', value: 'Proposal sent' }] },
      },
    ],
  },
  {
    key: 'home_services',
    name: 'Home services',
    description:
      'Interiors, repairs, pest control, solar. A site measurement decides the quote, and the address is half the qualification.',
    statuses: [
      { name: 'Enquiry', category: 'open', colour: '#3b5bdb', isDefault: true },
      { name: 'Site visit scheduled', category: 'open', colour: '#0ca678' },
      { name: 'Measured / surveyed', category: 'open', colour: '#66a80f' },
      { name: 'Quotation sent', category: 'open', colour: '#f59f00' },
      { name: 'Work awarded', category: 'won', colour: '#2f9e44' },
      { name: 'Lost', category: 'lost', colour: '#e03131' },
      { name: 'Out of service area', category: 'invalid', colour: '#868e96' },
    ],
    stages: [
      { name: 'Enquiry', colour: '#3b5bdb', probability: 10 },
      { name: 'Site visit', colour: '#0ca678', probability: 35 },
      { name: 'Quotation', colour: '#f59f00', probability: 60 },
      { name: 'Advance pending', colour: '#7048e8', probability: 85 },
      { name: 'Awarded', colour: '#2f9e44', probability: 100, isWon: true },
      { name: 'Lost', colour: '#e03131', probability: 0, isLost: true },
    ],
    sources: [
      ...COMMON_SOURCES,
      { name: 'Urban Company / aggregator', type: 'paid', costModel: 'commission' },
      { name: 'Society / RWA tie-up', type: 'referral', costModel: 'commission' },
      { name: 'Past customer', type: 'internal', costModel: 'none' },
    ],
    lostReasons: [
      ...COMMON_LOST_REASONS,
      { name: 'Quote higher than a local vendor' },
      { name: 'Outside our service area' },
      { name: 'Postponed the work' },
    ],
    tags: [
      { name: 'Site measured', colour: '#66a80f' },
      { name: 'Urgent', colour: '#e8590c' },
      { name: 'Society / bulk', colour: '#7048e8' },
      { name: 'Repeat customer', colour: '#0ca678' },
      { name: 'Do not call', colour: '#e03131' },
    ],
    fields: [
      {
        entityType: 'lead',
        key: 'service_required',
        label: 'Service',
        type: 'text',
        showInList: true,
      },
      { entityType: 'lead', key: 'site_address', label: 'Site address', type: 'textarea' },
      { entityType: 'lead', key: 'pincode', label: 'Pincode', type: 'text', showInList: true },
      { entityType: 'lead', key: 'site_visit_at', label: 'Site visit', type: 'datetime' },
      BUDGET_FIELD,
    ],
    views: [
      {
        name: 'Site visits due',
        description: 'Agreed and not yet done.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Site visit scheduled' }],
        },
      },
      {
        name: 'Quoted, waiting',
        description: 'A price is out and nobody has followed up.',
        filters: {
          conditions: [{ field: 'status.name', operator: 'eq', value: 'Quotation sent' }],
        },
      },
    ],
  },
];

export const INDUSTRY_TEMPLATE_KEYS: readonly string[] = INDUSTRY_TEMPLATES.map(
  (template) => template.key,
);

export function findIndustryTemplate(key: string): IndustryTemplate | undefined {
  return INDUSTRY_TEMPLATES.find((template) => template.key === key);
}

/**
 * What a template will install, as counts.
 *
 * The picker needs to say "9 statuses, 8 stages, 5 fields" rather than "a template": somebody
 * about to replace their workspace's vocabulary should be able to see how much of it changes.
 */
export interface IndustryTemplateSummary {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly statuses: number;
  readonly stages: number;
  readonly sources: number;
  readonly lostReasons: number;
  readonly tags: number;
  readonly fields: number;
  readonly views: number;
  /** The field labels, so the picker can show what a business is actually being offered. */
  readonly fieldLabels: readonly string[];
}

export function summariseIndustryTemplate(template: IndustryTemplate): IndustryTemplateSummary {
  return {
    key: template.key,
    name: template.name,
    description: template.description,
    statuses: template.statuses.length,
    stages: template.stages.length,
    sources: template.sources.length,
    lostReasons: template.lostReasons.length,
    tags: template.tags.length,
    fields: template.fields.length,
    views: template.views.length,
    fieldLabels: template.fields.map((field) => field.label),
  };
}
