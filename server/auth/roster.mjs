import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { AuthError } from './error.mjs';

const campusSchool = '西安欧亚学院';
const requiredHeaders = ['school', 'student_no', 'name'];
const optionalHeaders = ['phone'];
const normalize = (value) => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const studentNumber = /^[a-zA-Z0-9_-]{1,64}$/;
const digits = (value) => value.replace(/\D/g, '');

function validText(value, max) {
  return !!value && value.length <= max && !/[\p{C}]/u.test(value);
}

export function parseRoster(bytes) {
  let csv;
  try {
    csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('学校名单必须使用 UTF-8 编码。');
  }

  let rows;
  try {
    rows = parse(csv, { info: true, skip_empty_lines: true, max_record_size: 1024 });
  } catch (error) {
    // CSV parser errors can contain the actual record.
    throw new Error(`学校名单第 ${error.lines ?? 1} 行 CSV 格式无效。`);
  }
  const header = rows.shift()?.record.map((value) => value.trim()) ?? [];
  if (!requiredHeaders.every((key) => header.includes(key)) ||
      header.some((key) => !requiredHeaders.includes(key) && !optionalHeaders.includes(key))) {
    throw new Error('学校名单表头必须包含 school、student_no、name，可选 phone。');
  }

  const students = new Map();
  const [schoolAt, numberAt, nameAt] = requiredHeaders.map((key) => header.indexOf(key));
  const phoneAt = header.indexOf('phone');
  for (const { record, info } of rows) {
    const line = info.lines;
    const school = normalize(record[schoolAt]);
    const studentNo = normalize(record[numberAt]);
    const name = normalize(record[nameAt]);
    const phone = phoneAt >= 0 ? normalize(record[phoneAt]) : '';
    if (!validText(school, 120) || !studentNumber.test(studentNo) || !validText(name, 64) ||
        (phoneAt >= 0 && (!validText(phone, 32) || !/^\+?\d{7,20}$/.test(digits(phone))))) {
      throw new Error(`学校名单第 ${line} 行的学校、学号、姓名或手机号无效。`);
    }
    const previous = students.get(studentNo);
    if (previous) throw new Error(`学校名单第 ${line} 行与第 ${previous.line} 行的学号重复。`);
    students.set(studentNo, { school, name, phone, line });
  }
  if (!students.size) throw new Error('学校名单为空。');
  const hasPhone = phoneAt >= 0 && [...students.values()].every(({ phone }) => !!phone);

  function lookup(body) {
    const school = normalize(body.school);
    const studentNo = normalize(body.studentNo);
    const name = normalize(body.name);
    const entry = students.get(studentNo);
    if (school !== campusSchool || !entry || entry.school !== campusSchool || entry.name !== name) {
      throw new AuthError('STUDENT_AUTH', '学号、姓名或手机号后四位不匹配。', 422);
    }
    if (!hasPhone || !entry.phone) {
      throw new AuthError('ROSTER_PHONE', '学校名单缺少手机号，暂时无法使用学号登录。', 503);
    }
    const last4 = normalize(body.phoneLast4);
    if (!/^\d{4}$/.test(last4) || digits(entry.phone).slice(-4) !== last4) {
      throw new AuthError('STUDENT_AUTH', '学号、姓名或手机号后四位不匹配。', 422);
    }
    return { school: entry.school, name: entry.name, studentNo, phone: entry.phone };
  }

  return Object.assign(function validateRegistration(body) {
    const school = normalize(body.school);
    const studentNo = normalize(body.studentNo);
    if (!validText(school, 120)) throw new AuthError('REGISTRATION_FIELDS', '请填写学校。', 422);
    if (school !== campusSchool) throw new AuthError('EXTERNAL_SCHOOL', '本活动面向西安欧亚学院学生。', 422);
    const entry = students.get(studentNo);
    if (!entry) throw new AuthError('STUDENT_NOT_FOUND', '学校名单中找不到该学号。', 422);
    if (entry.school !== campusSchool) throw new AuthError('EXTERNAL_SCHOOL', '本活动面向西安欧亚学院学生。', 422);
    if (normalize(body.name) !== entry.name) throw new AuthError('NAME_MISMATCH', '姓名与学校名单不符。', 422);

    const grade = normalize(body.grade);
    const college = normalize(body.college);
    const className = normalize(body.className);
    const phone = normalize(body.phone);
    const email = normalize(body.email);
    if (!validText(grade, 32) || !validText(college, 120) || !validText(className, 120) ||
        !validText(phone, 32) || !/^\+?\d{7,20}$/.test(phone.replace(/[ ()-]/g, '')) ||
        !validText(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError('REGISTRATION_FIELDS', '请检查年级、学院、班级、电话和邮箱。', 422);
    }
    return { studentNo, name: entry.name, grade, college, className, phone, email };
  }, { lookup, hasPhone });
}

export function loadRoster(filename, mock) {
  if (mock && !filename) return parseRoster(readFileSync(new URL('./roster.example.csv', import.meta.url)));
  if (!filename || !isAbsolute(filename)) throw new Error('CAMPUS_ROSTER_CSV 必须是名单文件的绝对路径。');

  const file = realpathSync(filename);
  const workspace = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const fromWorkspace = relative(workspace, file);
  if (!mock && !isAbsolute(fromWorkspace) && !fromWorkspace.startsWith(`..${sep}`)) {
    throw new Error('正式学校名单必须放在项目目录外。');
  }
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('学校名单必须是 8 MB 以内的 CSV 文件。');
  return parseRoster(readFileSync(file));
}
