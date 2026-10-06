// Bound automatic checks and terminate only their own process group.
function createBudget(getChildren,onExpired,durationMs=55000) {
  let expired=false;
  const until=performance.now()+durationMs;
  const timer=setTimeout(()=>{
    expired=true;
    onExpired();
    for(const child of getChildren()) if(child?.pid) {
      if(process.platform==='win32') require('node:child_process').spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:2000});
      else try { process.kill(-child.pid,'SIGKILL'); } catch {}
    }
  },durationMs);
  return {get expired(){return expired || performance.now()>=until;},cancel(){clearTimeout(timer);}};
}
module.exports={createBudget};
