/**
 * 공용 입력 형식 규약.
 *
 * 코드성 식별자(환자ID·검사코드·LOINC·EDI 코드 등)는 HL7 발신 시 세그먼트·필드 구분자
 * 위치에 그대로 들어간다. 발신 측 escHl7이 1차 방어이지만, 애초에 구분자·개행이 들어갈 수
 * 없는 값이므로 입력 단계에서 문자 집합을 좁혀 2차 방어를 둔다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const CODE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const CODE_ID_MESSAGE = '영문·숫자와 . _ : - 만 허용됩니다(구분자·공백·개행 불가)';
