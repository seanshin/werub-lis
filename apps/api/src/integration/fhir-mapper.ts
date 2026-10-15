/**
 * LIS 결과 → HL7 FHIR R4 (HIS 수신 형식) — HIS 회신서 v1.1 §B.3 준수.
 * 형식: DiagnosticReport 단건 + contained[]에 Observation(값 포함).
 *   - basedOn: ServiceRequest/{orderId} 로 오더 결속(권장)
 *   - identifier[].value = 검체 바코드(휴리스틱 매칭용)
 *   - 결과값은 contained Observation에 포함(참조만으로는 값 수신 불가)
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface FhirResultLine {
  loinc: string;
  testName: string;
  value: string;
  unit: string;
  flag: string | null; // N/H/L/HH/LL
  status: string; // P/F/C
  refLow?: number | null;
  refHigh?: number | null;
}

export interface FhirResultInput {
  patientId: string; // HIS FHIR Patient id (또는 MRN)
  specimenNo: string; // 검체 바코드
  orderId?: string | null; // HIS ServiceRequest id(있으면 basedOn 결속)
  reflexOrderIds?: string[] | null; // 승인된 Reflex add-on의 HIS 정식 오더번호(urn:his:order) — 청구 결속
  results: FhirResultLine[];
}

type FhirResource = Record<string, unknown>;

function obsStatus(s: string): string {
  if (s === 'F') return 'final';
  if (s === 'C') return 'corrected';
  return 'preliminary';
}

function interpretation(flag: string | null): FhirResource[] | undefined {
  if (!flag || flag === 'N') return undefined;
  if (!['H', 'L', 'HH', 'LL'].includes(flag)) return undefined;
  return [
    {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: flag },
      ],
    },
  ];
}

function isNumeric(v: string): boolean {
  return v.trim() !== '' && !Number.isNaN(Number(v));
}

function toObservation(r: FhirResultLine): FhirResource {
  const obs: FhirResource = {
    resourceType: 'Observation',
    status: obsStatus(r.status),
    code: { coding: [{ system: 'http://loinc.org', code: r.loinc, display: r.testName }] },
  };
  if (isNumeric(r.value)) {
    obs.valueQuantity = { value: Number(r.value), unit: r.unit, system: 'http://unitsofmeasure.org' };
  } else {
    obs.valueString = r.value;
  }
  if (r.refLow != null || r.refHigh != null) {
    obs.referenceRange = [
      {
        ...(r.refLow != null ? { low: { value: r.refLow } } : {}),
        ...(r.refHigh != null ? { high: { value: r.refHigh } } : {}),
      },
    ];
  }
  const interp = interpretation(r.flag);
  if (interp) obs.interpretation = interp;
  return obs;
}

/**
 * HIS FHIR로 POST할 DiagnosticReport(contained Observations) 생성.
 * POST /fhir/R4/DiagnosticReport (scope system/DiagnosticReport.write)
 */
export function buildDiagnosticReport(input: FhirResultInput): FhirResource {
  const report: FhirResource = {
    resourceType: 'DiagnosticReport',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '11502-2', display: 'Laboratory report' }] },
    subject: { reference: `Patient/${input.patientId}` },
    identifier: [{ value: input.specimenNo }],
    contained: input.results.map(toObservation),
  };
  // basedOn: 원오더 + 승인된 Reflex add-on 정식 오더(중복 제거) — add-on 결과의 청구 결속
  const refs = [
    ...(input.orderId ? [input.orderId] : []),
    ...(input.reflexOrderIds ?? []),
  ].filter((v, i, a) => v && a.indexOf(v) === i);
  if (refs.length) {
    report.basedOn = refs.map((r) => ({ reference: `ServiceRequest/${r}` }));
  }
  return report;
}
