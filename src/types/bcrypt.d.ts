declare module 'bcrypt' {
  const bcrypt: {
    compare(data: string, encrypted: string): Promise<boolean>;
    hash(data: string, saltOrRounds: number | string): Promise<string>;
    genSalt(rounds?: number): Promise<string>;
  };

  export default bcrypt;
}
