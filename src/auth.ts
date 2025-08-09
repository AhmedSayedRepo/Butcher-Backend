import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';

export function sign(user:{id:string,role:string}){
  return jwt.sign({id:user.id, role:user.role}, JWT_SECRET, { expiresIn: '7d' });
}

export function verify(token:string){
  try{
    return jwt.verify(token, JWT_SECRET);
  }catch(e){
    return null;
  }
}
