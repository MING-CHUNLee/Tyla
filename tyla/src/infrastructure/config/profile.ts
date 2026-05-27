/**
 * Global user profile — stored at ~/.tyla/profile.json.
 * Manually edited by the user; contains identity fields shared across all projects.
 */

import fs from 'fs';
import path from 'path';
import { getProfileFile } from './paths';

export interface UserProfile {
    studentId: string;
    courseId: string;
    projectId: string;
}

export function getProfile(baseDir?: string): UserProfile | null {
    try {
        const raw = fs.readFileSync(getProfileFile(baseDir), 'utf-8');
        const parsed = JSON.parse(raw);
        if (
            typeof parsed?.studentId === 'string' &&
            typeof parsed?.courseId  === 'string' &&
            typeof parsed?.projectId === 'string'
        ) {
            return {
                studentId: parsed.studentId,
                courseId:  parsed.courseId,
                projectId: parsed.projectId,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function saveProfile(profile: UserProfile): void {
    const file = getProfileFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profile, null, 2), 'utf-8');
}
