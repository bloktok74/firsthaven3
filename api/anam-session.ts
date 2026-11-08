import {createAnamHandler} from '../server/anam-api.ts';
export default {fetch(request:Request):Promise<Response>{return createAnamHandler(process.env)(request);}};
