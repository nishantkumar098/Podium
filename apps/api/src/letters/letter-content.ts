/**
 * The wording of every letter, transcribed from AMM's own documents (typos
 * in the originals fixed). Each builder takes the prepared field values from
 * buildLetterData and returns layout blocks for letter-pdf.ts to draw.
 *
 * Person-supplied values are always inserted as plain text runs, never parsed
 * for formatting, so nothing typed into a form can change how a letter looks.
 */
export type Run = string | { b: string };

export type Block =
  | { t: "title"; text: string }
  | { t: "h"; text: string }
  | { t: "p"; runs: Run[]; align?: "left" | "justify" | "center" | "right"; gap?: number }
  | { t: "list"; items: Run[][]; style: "bullet" | "number" }
  | { t: "table"; header: string[]; rows: string[][]; widths: number[] }
  | { t: "space"; h: number }
  /** Archit Singhal's signature (assets/archit-signature.png), as on AMM's letters. */
  | { t: "signature" }
  /** Kept on one page — a signature block split across a page break is useless. */
  | { t: "keep"; blocks: Block[] };

type Data = Record<string, unknown>;

const s = (d: Data, k: string) => String(d[k] ?? "");
const arr = (d: Data, k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : []);
const p = (...runs: Run[]): Block => ({ t: "p", runs });
const pj = (...runs: Run[]): Block => ({ t: "p", runs, align: "justify" });
const b = (text: string): Run => ({ b: text });
const space = (h = 10): Block => ({ t: "space", h });

/**
 * Archit's signature where he is the one signing, and blank space where
 * somebody else is — a letter that prints his signature over another
 * person's name is a forged letter, so this is keyed on the name.
 */
const signatureFor = (name: string): Block => (/archit\s+singhal/i.test(name) ? { t: "signature" } : space(26));

const authorisedSignatory = (designation: string): Block => ({
  t: "keep",
  blocks: [
    p(b("For AMM BRANDS LLP")),
    { t: "signature" },
    p("______________________________"),
    p(b("Authorized Signatory")),
    p(b("Name: "), "Archit Singhal"),
    p(b("Designation: "), designation),
    p(b("Company Seal & Signature")),
  ],
});

/** The CEO sign-off from AMM's joining and offer letters, with Archit's signature. */
const ceoSignOff: Block = {
  t: "keep",
  blocks: [
    p(b("For AMM Brands LLP")),
    p("Warm regards,"),
    { t: "signature" },
    p(b("Archit Singhal")),
    p(b("Chief Executive Officer")),
    p(b("AMM BRANDS LLP")),
    p("Contact No: ", b("+91 11 46110364")),
  ],
};

const employeeAcceptance = (d: Data, name: string): Block => ({
  t: "keep",
  blocks: [
    p(b("EMPLOYEE ACCEPTANCE")),
    p("I have read, understood, and accepted the above terms and conditions of employment."),
    space(8),
    p(b("Employee Name: "), s(d, name)),
    p(b("Signature: "), "_______________________"),
    p(b("Date: "), "___________________________"),
  ],
});

// ------------------------------------------------------------------ HR
/**
 * Offer letter, transcribed from AMM's current template (the Tshitiz offer
 * letter): letterhead, the offer, nine numbered sections, the CEO sign-off
 * with Archit Singhal's signature, the candidate's acknowledgment, and
 * Annexure I with the CTC breakdown.
 *
 * The monthly figure in section 3 is not a separate field — it is BASIC plus
 * H.R.A from the annexure. In the source document the two disagreed (section
 * 3 said 18,000 while the annexure totalled 22,500), which is exactly the
 * kind of thing a candidate notices and a bank queries. Deriving it means
 * the letter cannot contradict its own annexure.
 */
function offerLetter(d: Data): Block[] {
  const docs = arr(d, "joiningDocuments").map((t) => [String(t)] as Run[]);
  const extra = arr(d, "otherTerms").map((t) => [String(t)] as Run[]);
  // Number fields arrive already grouped ("18,000") from buildLetterData, so
  // they have to be read back before the annexure can add them up.
  const num = (k: string) => Number(String(d[k] ?? "").replace(/[^\d.]/g, "")) || 0;
  const basic = num("basic");
  const hra = num("hra");
  const monthly = basic + hra;
  const money = (n: number) => n.toLocaleString("en-IN");

  return [
    { t: "title", text: "OFFER LETTER" },
    p(b("AMM BRANDS LLP")),
    p("H-12-B, Green Park Main, Madhok Apartments, Block H, Green Park Extension, Green Park, New Delhi - 110016"),
    p("Phone: +91-11-46110364"),
    space(),
    p(b("Date: "), s(d, "date")),
    space(6),
    p(b(s(d, "candidateName"))),
    p(s(d, "address")),
    space(6),
    p(b("Subject: "), "Employment Offer Letter"),
    space(6),
    p("Dear ", b(s(d, "candidateName")), ","),
    pj(
      "We are pleased to extend to you this ",
      b("Offer Letter"),
      " for employment with ",
      b("AMM Brands LLP"),
      " as a ",
      b(s(d, "designation")),
      " at our company.",
    ),
    pj(
      "This ",
      b("Offer Letter"),
      " outlines the terms and conditions which you must abide by, during your employment with the Company. The terms and conditions herein shall be ancillary to the ",
      b("Company Policy / Employee Handbook"),
      " and the rules, regulations and policies of the Company including ",
      b("service protocols"),
      ", ",
      b("code of conduct"),
      " and any ",
      b("confidentiality agreements"),
      " as made by the Company from time to time.",
    ),

    { t: "h", text: "1. Roles and Responsibilities" },
    pj(
      "In your role as a ",
      b(s(d, "designation")),
      ", you will be responsible for supporting day-to-day operations within your department, upholding ",
      b("Company standards"),
      ", and contributing to a productive, professional work environment. Your performance and conduct will play an important role in the continued growth and success of the Company and any deviation from the above will result in ",
      b("disciplinary actions"),
      " taken against you as per the ",
      b("Company Policy / Employee Handbook"),
      ".",
    ),

    { t: "h", text: "2. Joining Date and Formalities" },
    pj(
      "Your ",
      b("Joining Date"),
      " with the Company shall be on ",
      b(s(d, "joiningDate")),
      ". Your employment will commence on such date, and you are required to report to the office of the Company on the above specified date. Upon your arrival, you shall be required to complete joining formalities including but not limited to an ",
      b("orientation session"),
      ", ",
      b("HR and administrative formalities"),
      " and an overview of your ",
      b("roles and responsibilities"),
      " at the company.",
    ),
    pj(
      "On your ",
      b("Joining Date"),
      " as specified above, you shall be required to bring the following documents and any other documents as instructed by the ",
      b("Human Resources (HR)"),
      " department of the Company:",
    ),
    { t: "list", style: "bullet", items: docs },

    { t: "h", text: "3. Compensation and Incentives" },
    {
      t: "list",
      style: "number",
      items: [
        [
          b("Fixed Pay: "),
          "Your monthly compensation shall be ",
          b(`INR ${money(monthly)}`),
          ", the breakdown of which has been detailed in ",
          b("Annexure-I"),
          ".",
        ],
        [b("Incentives: "), "You will be eligible for an incentive of ", b(s(d, "incentive")), " per event after completing ", b(s(d, "incentiveAfterEvents")), " events."],
        [b("Insurance: "), "Medical insurance cover to the amount of ", b(s(d, "insuranceCover")), "."],
        ...extra,
      ],
    },

    { t: "h", text: "4. Working Hours" },
    pj(
      "Your working hours shall be from ",
      b(s(d, "workingDays")),
      ", between ",
      b(s(d, "workingHours")),
      ". Flexibility may be required based on operational needs, and you may be asked to work on ",
      b("weekends or public holidays"),
      " as per the business requirements of the Company. This is subject to change as per ",
      b("Company Policy"),
      " or instructions by the Company / concerned department of the Company. Any ",
      b("extra hours working"),
      " shall be deemed to be included in your ",
      b("Compensation"),
      " and no extra payment shall be done for that.",
    ),

    { t: "h", text: "5. Probationary Period" },
    pj(
      "You shall be required to undergo a ",
      b("probationary period"),
      " of ",
      b(s(d, "probation")),
      " starting from the ",
      b("Joining Date"),
      " of your employment with the Company, during which your performance and suitability for the role will be evaluated. Upon satisfactory completion of this period, your position will be formally confirmed by the Company.",
    ),

    { t: "h", text: "6. Disciplinary Measures" },
    pj(
      "You must strictly adhere to the ",
      b("Company Policy / Employee Handbook"),
      " and the rules, regulations and policies of the Company including ",
      b("service protocols"),
      " and ",
      b("code of conduct"),
      " as amended from time to time. Failure to do so shall result in ",
      b("disciplinary procedures"),
      " under the ",
      b("Company Policy and Employee Handbook"),
      " being initiated against you, which may extend to the ",
      b("termination"),
      " of your employment with the Company and levy of penalties against you in accordance with the policies of the Company.",
    ),
    p(b("Termination and Notice Period")),
    pj(
      "In the event of ",
      b("termination of your employment"),
      " by either you or the Company, a minimum ",
      b(s(d, "noticePeriod")),
      " notice period must be served by you.",
    ),
    pj(
      "In the event the above notice period has not been served, or you have not informed the Company about your decision to terminate the employment, in such a case, the Company reserves the right to ",
      b("forfeit any pending salary, benefits, or dues"),
      ". The Company will not be liable to process the ",
      b("Full and Final Settlement"),
      " or issue ",
      b("relieving or experience letters"),
      " until all obligations are fulfilled.",
    ),
    pj(
      "If you are absent from work for a period of ",
      b(s(d, "abscondingDays")),
      " without providing any notice or affording any reasons or without serving the complete notice period as required as per this ",
      b("Offer Letter"),
      ", the same shall be treated as ",
      b("absconding"),
      " and the Company will be entitled to forthwith ",
      b("terminate"),
      " your employment and forfeit any ",
      b("pending salary, benefit or dues"),
      ".",
    ),

    { t: "h", text: "7. Full & Final Settlement and Exit Policy" },
    pj(
      "At the time of the ",
      b("termination of your employment"),
      " with the Company, however it may be, you shall be required to provide a complete ",
      b("handover of duties and responsibilities"),
      " before the Company initiates the ",
      b("Full & Final (F&F) settlement"),
      " process. This includes the return of all ",
      b("Company property"),
      ", submission of required documentation, and clearance from relevant ",
      b("departments"),
      " of the Company. The ",
      b("F&F process"),
      " will only begin once the Company verifies that all ",
      b("exit formalities"),
      " have been duly completed and approved by the reporting manager or concerned authority of the Company.",
    ),

    { t: "h", text: "8. Confidentiality" },
    pj(
      "As part of your employment with the Company, you are expected to maintain ",
      b("strict confidentiality"),
      " regarding all ",
      b("Company-related and client-related information"),
      ", including but not limited to ",
      b("internal processes"),
      ", ",
      b("business strategies"),
      ", ",
      b("pricing"),
      ", ",
      b("vendor details"),
      ", and ",
      b("client data"),
      ". You are prohibited from disclosing or using such information for personal or any other purpose than those of the Company. This shall include any ",
      b("verbal, written and/or digital information"),
      " belonging to the Company. Any ",
      b("breach of this confidentiality"),
      " obligation shall be considered as ",
      b("misconduct"),
      " and shall lead to ",
      b("disciplinary action"),
      ", including ",
      b("termination and/or legal consequences"),
      " as per ",
      b("Company policy / Employee Handbook"),
      ".",
    ),
    pj(
      "The above confidentiality obligations will subsist during the term of your employment and shall survive ",
      b("the termination"),
      " of your employment with the Company ",
      b("in perpetuity"),
      ".",
    ),

    { t: "h", text: "9. Acceptance of the Offer Letter" },
    pj(
      "To confirm your acceptance of this offer, please sign and return a copy of this letter by ",
      b(s(d, "acceptBy")),
      ", within ",
      b("3 working days"),
      " of receipt of the same. Your prompt response will help us initiate the ",
      b("onboarding process"),
      ". On the receipt of the signed ",
      b("Offer Letter"),
      " by the Company, you shall be sent a detailed ",
      b("induction schedule"),
      ", which will introduce you to our ",
      b("Company culture"),
      ", ",
      b("operational procedures"),
      ", and ",
      b("team structure"),
      ".",
    ),
    pj(
      "We are excited to welcome you to the ",
      b("AMM BRANDS LLP family"),
      ". Your skills and experience will be a ",
      b("valuable addition"),
      " to our team as we continue to strive for excellence and deliver outstanding experiences to our guests. We are confident that you will contribute meaningfully to the ongoing success and reputation of our brand.",
    ),
    pj("If you have any questions or require further clarification regarding any aspect of this offer, please do not hesitate to reach out to our ", b("HR team"), "."),
    space(14),
    ceoSignOff,
    space(18),

    {
      t: "keep",
      blocks: [
        p(b("Acknowledgment and Acceptance")),
        space(4),
        pj(
          "I, ",
          b(s(d, "candidateName")),
          ", hereby accept this ",
          b("Offer Letter"),
          " for the position of ",
          b(s(d, "designation")),
          " at AMM BRANDS LLP. I have read and understood the terms outlined above, and I agree to abide by them.",
        ),
        space(16),
        p(b("Signature: "), "_______________________________"),
        p(b("Date: "), "___________________________________"),
      ],
    },

    // Annexure on its own, so the salary breakdown is never split in half by
    // a page break — the one page somebody photographs and sends to a bank.
    {
      t: "keep",
      blocks: [
        space(20),
        p(b("Annexure I")),
        p(b("ANNUAL CTC (All Inclusive) CALCULATION")),
        space(6),
        {
          t: "table",
          header: ["Fixed Component", "Monthly", "Yearly"],
          rows: [
            ["BASIC", money(basic), money(basic * 12)],
            ["H.R.A", money(hra), money(hra * 12)],
            ["TOTAL (A)", money(monthly), money(monthly * 12)],
          ],
          widths: [0.4, 0.3, 0.3],
        },
      ],
    },
  ];
}
function joiningLetter(d: Data): Block[] {
  return [
    { t: "title", text: "JOINING LETTER" },
    p(b("AMM BRANDS LLP")),
    p(b("H-12-B, Green Park Main, Madhok Apartments, Block H, Green Park Extension, Green Park, New Delhi - 110016")),
    p(b("Phone: +91-11-46110364")),
    space(),
    p(b("Date: "), s(d, "date")),
    space(6),
    p("To,"),
    p(s(d, "employeeName")),
    p(s(d, "address")),
    space(6),
    p(b("Subject: Confirmation of Joining")),
    space(6),
    p(`Dear ${s(d, "employeeName")},`),
    pj(
      "With reference to the Offer/Appointment Letter issued to you by AMM Brands LLP, we are pleased to confirm and acknowledge your joining with the organization as ",
      b(s(d, "designation")),
      " in the ",
      b(s(d, "department")),
      ", effective from ",
      b(s(d, "joiningDate")),
      ".",
    ),
    pj("You will be based at ", b(s(d, "location")), " and will report to ", b(s(d, "reportingManager")), "."),
    pj(
      "Your employment shall be governed by the terms and conditions mentioned in your Offer/Appointment Letter and the policies, rules, and guidelines of the organization, as applicable from time to time.",
    ),
    pj("You are required to complete all necessary joining and onboarding formalities and submit the required documents to the Human Resources Department."),
    pj("We welcome you to AMM Brands LLP and look forward to your valuable contribution and a successful association with the organization."),
    space(14),
    ceoSignOff,
    space(18),
    employeeAcceptance(d, "employeeName"),
  ];
}

function experienceLetter(d: Data): Block[] {
  const who = `${s(d, "salutation")} ${s(d, "employeeName")}`;
  return [
    { t: "title", text: "EXPERIENCE LETTER" },
    p(b("Date: "), b(s(d, "date"))),
    space(),
    p(b("TO WHOM IT MAY CONCERN")),
    space(4),
    pj(
      "This is to certify that ",
      b(who),
      " was employed with AMM Brands LLP from ",
      b(s(d, "fromDate")),
      " to ",
      b(s(d, "toDate")),
      " as ",
      b(s(d, "designationWithArticle")),
      `. During ${s(d, "pronounPossessive")} tenure, ${who} was responsible for:`,
    ),
    { t: "list", style: "bullet", items: arr(d, "responsibilities").map((r) => [String(r)]) },
    pj(
      `Throughout ${s(d, "pronounPossessive")} employment, ${s(d, "pronounSubject")} demonstrated professionalism, dedication and a strong commitment to achieving organizational goals. ${s(d, "pronounSubjectCap")} performed assigned duties efficiently and maintained good professional relationships with colleagues and clients.`,
    ),
    pj(`We found ${s(d, "pronounObject")} to be sincere, hardworking and responsible in carrying out all assigned tasks.`),
    pj(`We wish ${s(d, "pronounObject")} every success in future endeavours.`),
    pj("Should you require any additional information, please feel free to contact us."),
    space(14),
    authorisedSignatory("Director"),
  ];
}

function relievingLetter(d: Data): Block[] {
  const who = `${s(d, "salutation")} ${s(d, "employeeName")}`;
  return [
    { t: "title", text: "RELIEVING LETTER" },
    p(b("Date: "), s(d, "date")),
    space(6),
    p("To,"),
    p(b(who)),
    p(s(d, "address")),
    space(6),
    p(`Dear ${who},`),
    space(4),
    p(b("Sub: Relieving from your employment")),
    space(4),
    pj(
      "You worked at AMM Brands LLP from ",
      b(s(d, "joiningDate")),
      " to ",
      b(s(d, "lastWorkingDate")),
      ". Pursuant to your cessation of employment with the company from ",
      b(s(d, "lastWorkingDate")),
      ", the Employment Agreement dated ",
      b(s(d, "agreementDate")),
      " (“Employment Agreement”) also stands terminated.",
    ),
    pj(
      "We would also like to take this opportunity to remind you that, notwithstanding the termination of your Employment Agreement, your continuing obligations under it will survive. These obligations include but may not be limited to the following obligations -",
    ),
    {
      t: "list",
      style: "number",
      items: [
        [
          "All developments made and works created by you during the term of your employment with the Company are the exclusive proprietary property of the Company, and any and all copyright(s) and other proprietary interest(s) therein shall belong to the Company in any form of media.",
        ],
        ["You shall not divulge the confidential information of the Company to any third party."],
        ["You shall not give any statement or send write-ups or post anything regarding the Company."],
      ],
    },
    pj(
      "You have received your full and final settlement, you have returned the properties of the company and have completed all formalities with respect to your cessation of employment with the company.",
    ),
    pj("If you have any questions concerning the information contained in this letter, please contact me directly."),
    pj("We wish you all the best for your future endeavours!"),
    space(6),
    p("Yours sincerely,"),
    p("Signed for and on behalf of the company by:"),
    space(10),
    authorisedSignatory("Director"),
  ];
}

function exitUndertaking(d: Data): Block[] {
  const clauses = [
    "That I am bound by obligations of confidentiality and secrecy in respect of the affairs of the Firm and its clients. I understand that these obligations continue even after the cessation of my association with the Firm.",
    "That the information, data, and materials relating to the affairs of the Firm, its clients, licensors, suppliers, and other third parties that are not publicly available are confidential and proprietary to the Firm. Confidential Information includes, but is not limited to, client data, business strategies, marketing plans, financial information, operational methodologies, computer systems, databases, project notes, and any other information that I came across during my association with the Firm.",
    "That before the cessation of my association, I have completed all exit formalities and have handed over to the designated person all Firm property assigned to me.",
    "That I have not retained in any form any data, documents, files, or confidential information of the Firm, nor have I provided or passed on any such information to any third party. I have permanently deleted all Firm-related data from my personal devices.",
    "That I shall not use or disclose, directly or indirectly, any confidential information of the Firm which may have come to my knowledge or possession during the course of my association, to any person, entity, agency, or authority for any purpose. I shall fully cooperate with the Firm in any internal inquiry and shall endeavor to satisfy every query in this regard.",
    "That for a period of 2 years from the date of this Undertaking, I shall not directly or indirectly solicit, approach, or service any client or customer of the Firm whom I was introduced to or became aware of during my association with the Firm. I shall not divert or attempt to divert any client or customer of the Firm to any competing business. I shall not solicit, induce, or attempt to induce any employee, consultant, or contractor of the Firm to terminate or reduce their relationship with the Firm. I shall not hire or engage any employee of the Firm who was known to me during my association.",
    "That this Undertaking shall be governed by the laws of India and courts at Delhi shall have exclusive jurisdiction.",
  ];
  return [
    { t: "title", text: "EXIT UNDERTAKING" },
    p(b("Date: "), s(d, "date")),
    space(6),
    pj("I, ", b(s(d, "employeeName")), ", former Employee at AMM Brands LLP (\"the Firm\"), hereby undertake as follows:"),
    { t: "list", style: "number", items: clauses.map((c) => [c]) },
    pj(
      "I do hereby declare that this Undertaking has been given by me of my own volition without any undue influence or duress and that the foregoing statements are true and correct. I undertake to abide by and comply with all the terms of this Undertaking.",
    ),
    space(16),
    { t: "keep", blocks: [p(b("Signature of the Executant")), space(22), p(b("_______________")), p(s(d, "employeeName"))] },
    space(16),
    {
      t: "keep",
      blocks: [
        p(b("For AMM Brands LLP")),
        p("Signature"),
        signatureFor(s(d, "companyRepName")),
        p(b("Name: "), s(d, "companyRepName")),
        p(b("Designation: "), s(d, "companyRepDesignation")),
        p(b("Date: "), s(d, "companyRepDate")),
      ],
    },
  ];
}

function assetAgreement(d: Data): Block[] {
  const rows = arr(d, "assets").map((r) => {
    const row = r as Record<string, string>;
    return [row.assetType ?? "", row.brandModel ?? "", row.serialNo ?? "", row.condition ?? ""];
  });
  const terms = [
    "The employee shall exercise reasonable care and maintain the asset(s) in good condition.",
    "The employee shall not transfer, lend, sell, modify, or allow unauthorized persons to use the asset(s). Any loss, theft, damage, or malfunction must be reported to the Company immediately.",
    "In case of negligence, misuse, unauthorized use, or intentional damage, the employee may be held financially responsible for repair or replacement costs. The employee hereby consents to the Company deducting such costs from their salary or any other dues, subject to applicable laws.",
    "Upon resignation, termination, transfer, or upon Company request, the employee shall return all issued assets in good working condition along with all accessories.",
    "The Company reserves the right to deduct the cost of unreturned assets or damages, subject to applicable laws and employee consent where required.",
    "All company data, files, documents, passwords, and information stored on the asset remain the property of the Company and must be returned or deleted as instructed. The employee agrees to maintain the confidentiality of all such company data and proprietary information, and this obligation shall survive the termination of this agreement.",
    "This Agreement shall be governed by and construed in accordance with the laws of India. The parties irrevocably submit to the exclusive jurisdiction of the courts at New Delhi, India, for the settlement of any disputes arising out of or in connection with this Agreement.",
  ];
  return [
    { t: "title", text: "Employee Asset Issuance & Responsibility Agreement" },
    pj("This agreement is entered into between ", b("AMM Brands LLP"), " and ", b(s(d, "employeeName")), " (\"Employee\") on ", b(s(d, "date")), "."),
    space(4),
    { t: "table", header: ["Asset Type", "Brand/Model", "Serial No.", "Condition"], rows, widths: [0.24, 0.3, 0.26, 0.2] },
    space(8),
    pj("The above-mentioned asset(s) remain the sole property of AMM Brands LLP and are provided exclusively for official business purposes."),
    { t: "list", style: "bullet", items: terms.map((x) => [x]) },
    pj("This agreement shall remain effective until the asset(s) are returned and acknowledged by the Company."),
    pj(b("Declaration: "), "I acknowledge receipt of the above-mentioned asset(s) and agree to comply with all terms and conditions stated in this agreement."),
    space(14),
    {
      t: "keep",
      blocks: [
        p(b("Employee Name: "), s(d, "employeeName"), "      ", b("Designation: "), s(d, "designation"), "      ", b("Contract: "), s(d, "contract")),
        space(18),
        p(b("Employee Signature: "), "______________________      ", b("Date: "), s(d, "date")),
      ],
    },
    space(16),
    // The issuing side was missing entirely. An asset handover the company
    // never countersigned is hard to rely on if the asset is not returned.
    {
      t: "keep",
      blocks: [p(b("Issued for AMM BRANDS LLP")), { t: "signature" }, p(b("Archit Singhal")), p(b("Designated Partner"))],
    },
  ];
}

// ----------------------------------------------------------- Freelancer
function freelanceAgreement(d: Data): Block[] {
  const h = (text: string): Block => ({ t: "h", text });
  return [
    { t: "title", text: "FREELANCE BARTENDING SERVICES AGREEMENT" },
    pj("This Freelance Bartending Service Agreement (the “", b("Agreement"), "”) is effective from ", b(s(d, "periodFrom")), " to ", b(s(d, "periodTo")), "."),
    p(b("BY AND BETWEEN")),
    pj(
      b(s(d, "freelancerName")),
      ", residing at ",
      s(d, "freelancerAddress"),
      " (the “Freelancer” which expression shall, unless repugnant to the context or meaning thereof, include his/her heirs, successors, legal representatives, administrators, executors and permitted assigns) of the FIRST PART:",
    ),
    p(b("AND")),
    pj(
      b("AMM Brands LLP"),
      " (hereinafter referred to as the “",
      b("Company"),
      "” which term include its representatives, subsidiaries, associate companies, successors, and permitted assignees), having its registered office at ",
      b("H-12-B, Green Park Main, New Delhi, Delhi 110016"),
      " of the OTHER PART:",
    ),
    pj("Hereinafter, the Freelancer and the Company shall individually be termed as “", b("Party"), "” and together termed as “", b("Parties"), "” to the present Agreement."),
    h("Scope of the Agreement"),
    pj(
      "Notwithstanding anything contained in this Agreement, the Freelancer agrees and confirms to provide ",
      b("freelance bartending services"),
      " as per the terms and conditions contained in this Agreement and as and when specified by the Company. In addition to this Agreement, the Freelancer shall adhere to ",
      b("Company Policy / Employee Handbook"),
      " and the rules, regulations and policies of the Company including ",
      b("service protocols, code of conduct"),
      " and any ",
      b("confidentiality agreements"),
      " entered into between the Parties.",
    ),
    h("Nature of Relationship Between the Parties"),
    pj(
      "The Freelancer hereby acknowledges that this Agreement does not constitute an ",
      b("Employee-Employer"),
      " relationship between the Company and the Freelancer. The Freelancer is an ",
      b("independent contractor"),
      " and shall not be entitled to entitlements afforded to Employees of the Company including but not limited to ",
      b("benefits, compensation and paid or unpaid leaves"),
      ".",
    ),
    h("Freelance Period and Compensation"),
    {
      t: "list",
      style: "number",
      items: [
        [
          "This Agreement shall subsist for a period between ",
          b(s(d, "periodFrom")),
          " and ",
          b(s(d, "periodTo")),
          " (“",
          b("Freelance Period"),
          "”) during which, the Freelancer shall be engaged by the Company for specific ",
          b("Event/Events"),
          " (hereinafter referred to as “",
          b("Event"),
          "” or “",
          b("Events"),
          "” which shall unless otherwise stated, mean social gatherings organized by the Company including but not limited to ",
          b("weddings, anniversaries, festivals"),
          " and ",
          b("house-parties"),
          ") organized by the Company. The Freelancer shall prioritize the Event work for the Company for the Freelance Period. He / She shall report on time and reporting late by ",
          b("60 minutes"),
          " will result in a deduction of ",
          b("INR 500"),
          " from his/her ",
          b("Compensation"),
          ".",
        ],
        ["The ", b("location, timings and period of the shift"), " for each Event shall be communicated by the Company to the Freelancer prior to the Event."],
        ["Upon arrival, the Freelancer shall attend the ", b("briefing by the designated team leader / supervisor"), " and is expected to be familiar with the Event ", b("menu and recipes"), "."],
        [
          "The ",
          b("Compensation"),
          " provided to the Freelancer shall be calculated as per ",
          b("number of hours"),
          " of the shift and will vary in case the shift is designated as ",
          b("Lunch or Dinner"),
          ". The specific amounts of each as well as ",
          b("overtime compensation"),
          " have been laid out in ",
          b("Annexure - 1"),
          ". ",
          b("Overtime"),
          " of the Freelancer shall be calculated as per “",
          b("Timing Out"),
          "” on the ",
          b("attendance system"),
          " of the Company.",
        ],
      ],
    },
    h("Dress Code and Equipment"),
    {
      t: "list",
      style: "number",
      items: [
        [
          "The Freelancer shall be responsible for wearing ",
          b("proper attire"),
          " for the Event which shall include - ",
          b("Black pants and White/Black Shirt"),
          ". He / She must be presentable and well groomed. The Freelancer must carry a proper ",
          b("bar kit"),
          " including but not limited to ",
          b("shaker set, hawthorn strainer, fine strainer, bar spoon, pourer, jigger, ice scoop and knife"),
          ".",
        ],
        [
          "Failure to meet ",
          b("dress code or equipment standards"),
          " may result in the assignment of the Freelancer to ",
          b("barback duties"),
          " or ",
          b("denial of entry"),
          " into the Event by the concerned ",
          b("Supervisor / Manager"),
          ".",
        ],
      ],
    },
    h("Code of Conduct"),
    {
      t: "list",
      style: "number",
      items: [
        [
          "The Freelancer must not consume any ",
          b("alcohol and any other intoxicating substance"),
          " before and during the Event. Consuming said substance, in any form, before and/or during the Event shall lead to ",
          b("Disciplinary Procedures"),
          " under the ",
          b("Company Policy / Employee Handbook"),
          " which may culminate in ",
          b("immediate termination"),
          " of this Agreement ",
          b("without payment"),
          ", at the sole discretion of the Company.",
        ],
        [
          "In case the Freelancer is found to be directly/indirectly involved in ",
          b("theft of property"),
          ", whether belonging to the Company, Event venue or attendees of the Event, he/she shall be ",
          b("blacklisted"),
          " from the Company and in addition to ",
          b("forfeiture"),
          " of the amounts payable to him/her, ",
          b("liable to compensate"),
          " the Company for the losses sustained by it.",
        ],
        ["The Freelancer shall not be allowed to share their ", b("personal contact number"), " with any of the ", b("clients"), " of the Company."],
        [
          "Any deliberate loss to the Company including but not limited to, ",
          b("missed flight and loss of uniform or any equipment"),
          " by the Freelancer will be ",
          b("deducted from the total Compensation"),
          " to be paid. At the sole discretion of the Company, the Company may deduct the same in parts at the request of the Freelancer.",
        ],
        [
          "The Freelancer shall not argue/misbehave with any attendee or co-worker at the Event under any circumstances. He/she shall immediately inform the concerned ",
          b("Supervisor / Manager"),
          " in case of any dispute.",
        ],
        [
          "The Freelancer shall not leave the bar without informing the concerned ",
          b("Supervisor / Manager"),
          ". Any such ",
          b("unauthorized absence"),
          " shall result in ",
          b("deduction of Compensation"),
          " provided to the Freelancer.",
        ],
        [
          "The Freelancer who provides insight of any behavior against the present Agreement, Company Policy / Employee Handbook by any co-worker along with sufficient proof of the same shall be rewarded. In such cases, the identity of the reporting Freelancer shall be kept ",
          b("anonymous"),
          ".",
        ],
        ["The Freelancer demonstrating ", b("professional and ethical behavior"), " at the Event shall be rewarded with ", b("better and higher Event allocation"), "."],
        [
          "Notwithstanding anything stated above, any ",
          b("breach of the Code of Conduct"),
          " of the present Agreement and/or the Company Policy / Employee Handbook shall result in ",
          b("immediate termination"),
          " of the Freelancer and any such ",
          b("remedial measures"),
          " that the Company may deem appropriate including but not limited to ",
          b("denying / withholding compensation, blacklisting"),
          " the Freelancer from future Events and/or any rights or remedies available to the Company in law or equity.",
        ],
      ],
    },
    h("Compensation"),
    {
      t: "list",
      style: "number",
      items: [
        ["The ", b("Compensation"), " shall be paid as per the rates as specified in ", b("Annexure 1"), "."],
        [
          "Inability to put the correct “",
          b("Timing In"),
          "” and “",
          b("Timing Out"),
          "” on the ",
          b("attendance system"),
          " of the Company shall result in ",
          b("compensation to the Freelancer being Nil"),
          " for that period. In case there exists an inability to punch time for clocking in for the assigned shift, the Freelancer may keep the ",
          b("Shift Slip"),
          " from the concerned ",
          b("Supervisor / Manager"),
          " as a backup, after getting the shift slip signed by the concerned Supervisor / Manager. The “Timing In” and “Timing Out” for the Event shall be specified by the concerned ",
          b("HO / Manager"),
          " one day prior to the Event on the ",
          b("dedicated WhatsApp group"),
          " for the same.",
        ],
        [
          "All payments pertaining to the ",
          b("Compensation"),
          " to the Freelancer shall be done by ",
          b("12th to 15th"),
          " of every month unless delayed by further clarification or dispute.",
        ],
        [
          "At any instance, the Freelancer is not allowed to call the ",
          b("Owner/ Coordinator"),
          " of the Company for ",
          b("payment issue/ expenses/allocation"),
          ". Any issues which require immediate attention will be solved by the concerned ",
          b("Supervisor / Managers"),
          " only. In case the Freelancer has incurred any ",
          b("expense"),
          " on behalf of the Company, the same will be paid within ",
          b("48 hours"),
          " of putting the expenses on the ",
          b("Attendance system"),
          " along with the ",
          b("receipt"),
          " of the expense. All expenses will be paid by Attendance System and no expense will be orally paid or by WhatsApp message.",
        ],
      ],
    },
    h("Miscellaneous"),
    {
      t: "list",
      style: "number",
      items: [
        ["This present Agreement is a 6 months “", b("Loyalty Program"), "” by the Company which shall culminate in a ", b("bonus"), " for the Freelancer at the end of such period."],
        [
          "In case of the Freelancer failing to arrive for the Event by reason of accepting a ",
          b("freelance/employment opportunity"),
          " in any capacity, with a ",
          b("competitor"),
          " of the Company, shall result in ",
          b("forfeiture of the entire Compensation"),
          " being owed to such Freelancer.",
        ],
        [
          "Positive ",
          b("feedback"),
          " pertaining to the services of a Freelancer by the attendees of the Event shall result in a ",
          b("higher rating"),
          " being assigned to the Freelancer for the purposes of a ",
          b("performance-based payout"),
          ".",
        ],
        [
          "In cases wherein the Freelancer facilitates ",
          b("new business"),
          " for the Company in the form of an Event or product sale by way of reference, he/she shall be entitled for a ",
          b("commission amounting to 10 percent"),
          " of the total contract value of the Event or the sale as the case may be. This ",
          b("commission"),
          " shall be remitted to the Freelancer within ",
          b("one week"),
          " of the culmination of the Event / sale or once the Company receives full payment for that Event / sale, whichever is later.",
        ],
        ["Calculation of ", b("Baraat / After Party / Welcome Drink"), " will be adjusted and paid under ", b("shift timing"), "."],
        [
          "In case there is any ",
          b("dispute"),
          " arising out of or from this Agreement it shall be governed by, interpreted and enforced in accordance with the ",
          b("laws of India"),
          ", without regard to or application of choice of law rules or principles. Such dispute shall firstly be resolved through ",
          b("amicable negotiations"),
          " between the Parties. The ",
          b("courts in Delhi"),
          " shall have exclusive jurisdiction over all matters arising pursuant to this Agreement.",
        ],
        [
          "The Company shall have the right to ",
          b("assign or transfer"),
          " this Agreement, in whole or in part, to any of its ",
          b("affiliates, group companies, successors"),
          ", or any entity acquiring all or substantially all of its business or undertaking, without requiring any further consent from the Freelancer. The Freelancer hereby expressly agrees to such assignment or transfer and shall continue to be bound by the terms of this Agreement.",
        ],
      ],
    },
    space(8),
    {
      t: "keep",
      blocks: [
        p(b("MISSION")),
        pj(
          "AT ELIXIR, WE CRAFT EXPERIENCES AND LASTING MOMENTS BY DELIVERING EXCEPTIONAL SERVICES COMBINED WITH CREATIVITY, PERSONALISED SERVICES AND A DEEP PASSION FOR MIXOLOGY DELIVERED BY A TEAM ROOTED IN HONESTY AND LOYALTY.",
        ),
        p(b("VISION")),
        pj("TO BE THE TOP BEVERAGE SPECIALIST WITH SHARP FOCUS ON CUSTOMER SATISFACTION AND CONVERTING OUR CLIENTS’ VISION TO REALITY."),
        p(b("VALUES")),
        pj(
          "CLIENT SUCCESS, INTEGRITY, TEAMWORK, EXCELLENCE, HOSPITALITY, ADAPTABILITY, RESPONSIBILITY, SAFETY AND SUSTAINABILITY. KINDLY UPHOLD THE ABOVE VALUES WHILE WORKING WITH OUR COMPANY AND DEALING WITH CUSTOMERS.",
        ),
      ],
    },
    space(18),
    {
      t: "keep",
      blocks: [p(b("..............................")), p(b("SIGNATURE")), p(b("NAME: "), b(s(d, "freelancerName"))), p(b("DATE: "), b(s(d, "date")))],
    },
    space(16),
    // Only the Freelancer signed in the original. A two-party agreement with
    // one signature line is not executed, so the Company's side is added.
    {
      t: "keep",
      blocks: [
        p(b("FOR AMM BRANDS LLP")),
        { t: "signature" },
        p(b("NAME: "), b("Archit Singhal")),
        p(b("DESIGNATION: "), b("Designated Partner")),
        p(b("DATE: "), b(s(d, "date"))),
      ],
    },
    space(18),
    {
      t: "keep",
      blocks: [
        p(b("ANNEXURE – 1 COMPENSATION PAYOUT CHART")),
        space(4),
        {
          t: "table",
          header: ["SHIFT TIMING", "DELHI NCR", "OUTSIDE DELHI NCR"],
          rows: [
            ["LUNCH SHIFT (6 HOUR)", `INR ${s(d, "lunchDelhi")}`, `INR ${s(d, "lunchOutside")}`],
            ["DINNER SHIFT (8-10 HOUR)", `INR ${s(d, "dinnerDelhi")}`, `INR ${s(d, "dinnerOutside")}`],
          ],
          widths: [0.4, 0.3, 0.3],
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------- Client
function engagementLetter(d: Data): Block[] {
  const who = `${s(d, "salutation")} ${s(d, "clientName")}`;
  const bullets = (k: string): Block => ({ t: "list", style: "bullet", items: arr(d, k).map((x) => [String(x)]) });
  return [
    { t: "p", runs: [s(d, "date")], align: "right" },
    p("To,"),
    p(b(who)),
    space(4),
    p(b("Subject: Engagement Letter")),
    space(4),
    p(`Dear ${s(d, "dearTitle")},`),
    pj(
      "First of all, at the outset, we thank you for considering us for the services pertaining to planning and co-ordinating the cocktail events for the upcoming wedding in the family (“Services”).",
    ),
    pj(
      "The following proposal lays out the scope of work and other related details. Please note that our Services shall be subject to the Terms and conditions as mentioned in Appendix A.",
    ),
    { t: "h", text: "1. WEDDING DETAILS" },
    p(b("Wedding Date: "), `${s(d, "weddingDate")} (the “Wedding”)`),
    p(b("Wedding Location: "), s(d, "weddingLocation")),
    p(b("No. of Pax: "), `${s(d, "pax")} pax`),
    pj("For the purposes of this Engagement Letter, the Wedding Day and the Pre-Wedding functions together shall be referred to as “Celebration”."),
    { t: "h", text: "2. CLIENT DETAILS" },
    p(b("Name - "), who),
    p(b("Contact Details - "), s(d, "clientPhone")),
    p(b("Email Id - "), s(d, "clientEmail")),
    p(b("Address - "), s(d, "clientAddress")),
    { t: "h", text: "3. SCOPE OF WORK" },
    p("We shall provide following services/manpower to the Client at the Wedding:"),
    bullets("manpower"),
    p(b("Common Deliverables")),
    bullets("deliverables"),
    p(b("Exclusions:")),
    bullets("exclusions"),
    p(b("Note:")),
    {
      t: "list",
      style: "bullet",
      items: [
        [
          "The Client shall provide relevant information and more particularly the theme of the Wedding based on which the material is to be procured well in advance to us but in no event later than 45 days before the date of the Wedding.",
        ],
        ["Any change in the number of pax or any event details shall be informed by the Client well in advance and in no event later than 3 days before the Wedding."],
        ["The Client shall not be responsible to deal with or make any payments to any vendor/third parties that may be engaged by us to perform the Services."],
      ],
    },
    { t: "h", text: "4. PRICING AND PAYMENT TERMS" },
    pj(
      b("4.1 Total Fees: "),
      `INR ${s(d, "totalFees")} (${s(d, "totalFeesInWords")}) plus applicable taxes. This fee includes the cost of travel, stay and food of our team required for delivering the Services.`,
    ),
    p(b("4.2 Payment Schedule:")),
    {
      t: "list",
      style: "bullet",
      items: [
        ["Upfront at the time of signing the Engagement Letter – 50% (fifty percent) of the Total Fees."],
        ["One week before the first event of the Wedding – 25% (twenty five percent) of the Total Fees."],
        ["Before the end of the operations on the Wedding Day – Balance 25% (twenty five percent) of the Total Fees."],
      ],
    },
    p(b("Bank Account Details: "), "As per PDF shared"),
    pj(
      "We request you to sign the duplicate of this offer letter as a token of your acceptance of the terms mentioned therein and send it to us to enable us to commence work on the transaction.",
    ),
    space(14),
    { t: "keep", blocks: [p(b("For AMM BRANDS LLP")), { t: "signature" }, p(b("Archit Singhal")), p(b("Designated Partner"))] },
  ];
}

export const LETTER_CONTENT: Record<string, (d: Data) => Block[]> = {
  "offer-letter": offerLetter,
  "joining-letter": joiningLetter,
  "experience-letter": experienceLetter,
  "relieving-letter": relievingLetter,
  "exit-undertaking": exitUndertaking,
  "asset-agreement": assetAgreement,
  "freelance-agreement": freelanceAgreement,
  "engagement-letter": engagementLetter,
};

/** Every word a letter will print, in order — used by tests without parsing a PDF. */
export function blocksText(blocks: Block[]): string {
  const run = (r: Run) => (typeof r === "string" ? r : r.b);
  return blocks
    .map((bl) => {
      switch (bl.t) {
        case "title":
        case "h":
          return bl.text;
        case "p":
          return bl.runs.map(run).join("");
        case "list":
          return bl.items.map((i) => i.map(run).join("")).join("\n");
        case "table":
          return [bl.header, ...bl.rows].map((r) => r.join(" | ")).join("\n");
        case "keep":
          return blocksText(bl.blocks);
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}
