export interface AuthenticatedUser {
  sub: string;
  userId: string;
  cognitoSub: string;
  email?: string;
  name?: string;
  username?: string;
  role?: string;
}
