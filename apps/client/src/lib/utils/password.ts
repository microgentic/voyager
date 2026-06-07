// Backend requires new passwords/passphrases to be ≥ 14 chars (master plan:
// favor length over composition rules). This gives lightweight client feedback.

export const MIN_PASSWORD_LENGTH = 14;

export interface PasswordStrength {
	score: 0 | 1 | 2 | 3 | 4;
	label: string;
	meetsMinimum: boolean;
}

export function passwordStrength(password: string): PasswordStrength {
	const length = password.length;
	const meetsMinimum = length >= MIN_PASSWORD_LENGTH;

	let score = 0;
	if (length >= MIN_PASSWORD_LENGTH) score += 1;
	if (length >= 20) score += 1;
	if (length >= 28) score += 1;
	const variety =
		Number(/[a-z]/.test(password)) +
		Number(/[A-Z]/.test(password)) +
		Number(/[0-9]/.test(password)) +
		Number(/[^A-Za-z0-9]/.test(password));
	if (variety >= 3) score += 1;

	const clamped = Math.min(4, score) as PasswordStrength['score'];
	const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
	return {
		score: clamped,
		label: meetsMinimum ? labels[clamped] : 'Too short',
		meetsMinimum
	};
}
