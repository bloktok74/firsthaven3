import {createAnamEngineHandler} from '../server/anam-api.ts';
export default {fetch(request:Request):Promise<Response>{return createAnamEngineHandler(process.env)(request);}};
