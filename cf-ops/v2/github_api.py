"""Owner GitHub REST functions + public GitHub CLI OAuth application device flow.

No GitHub token is placed in a command line, stdout, audit log or exception.
The GitHub CLI OAuth application's public client ID comes from cli/cli
internal/authflow/flow.go. Device flow requests only the 'repo' scope, the
GitHub OAuth scope required to edit private repositories and pull requests.
"""
import base64
import hashlib
import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

CLIENT_ID = "178c6fc778ccc68e1d6a"
OWNER = "homayounisaghar"
MAX_FILE = 4 * 1024 * 1024

class GithubProblem(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code

def check(value, code):
    if not value:
        raise GithubProblem(code)

def store_json(path, obj):
    temp = path.with_name(path.name+".tmp."+os.urandom(6).hex())
    with temp.open("x") as f:
        os.chmod(temp, 0o600)
        json.dump(obj,f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp,path)
    os.chmod(path,0o600)

def repo_ok(repo):
    check(isinstance(repo,str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",repo), "INVALID_REPO")
    # Avoid cross-owner repository writes: this service is the owner's personal integration.
    check(repo.split("/")[0].lower() == OWNER.lower(), "REPO_OWNER_FORBIDDEN")
    return repo

def ref_ok(value):
    check(isinstance(value,str) and len(value) < 240 and
          not value.startswith("/") and ".." not in value and
          re.fullmatch(r"[a-zA-Z0-9_./-]+",value), "INVALID_REF")
    return value

def path_ok(value):
    check(isinstance(value,str) and 0 < len(value) <= 1024 and
          not value.startswith("/") and "\x00" not in value and
          not any(x in ("",".","..") for x in value.split("/")), "INVALID_GIT_PATH")
    return value

def segment(value):
    return urllib.parse.quote(value, safe="")

class GithubAPI:
    def __init__(self, state):
        self.dir = pathlib.Path(state)/"github"
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.tokenfile = self.dir/"token.json"
        self.devicefile = self.dir/"device.json"

    @staticmethod
    def request(url, method="GET", payload=None, token=None, accept="application/vnd.github+json"):
        headers = {"Accept":accept, "User-Agent":"cf-ops-agent/1", "X-GitHub-Api-Version":"2022-11-28"}
        if token:
            headers["Authorization"] = "Bearer "+token
        data = json.dumps(payload).encode() if payload is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read(12 * 1024 * 1024 + 1)
                check(len(raw)<=12*1024*1024, "GITHUB_RESPONSE_TOO_LARGE")
                if not raw:
                    return {}
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            # Never include a provider error body: it could echo confidential input.
            raise GithubProblem("GITHUB_HTTP_"+str(e.code))
        except (urllib.error.URLError, TimeoutError):
            raise GithubProblem("GITHUB_TRANSPORT_FAILED")

    @staticmethod
    def form(path, data):
        encoded = urllib.parse.urlencode(data).encode()
        headers = {"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded",
                   "User-Agent":"cf-ops-agent/1"}
        req = urllib.request.Request("https://github.com"+path, data=encoded, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                return json.loads(response.read(16000))
        except (urllib.error.URLError, TimeoutError):
            raise GithubProblem("GITHUB_DEVICE_TRANSPORT_FAILED")

    def token(self):
        try:
            with self.tokenfile.open() as f:
                token = json.load(f)["access_token"]
            check(isinstance(token,str) and len(token)>25, "GITHUB_LOGIN_REQUIRED")
            return token
        except (FileNotFoundError, KeyError, ValueError):
            raise GithubProblem("GITHUB_LOGIN_REQUIRED")

    def api(self, path, method="GET", payload=None):
        return self.request("https://api.github.com"+path, method, payload, self.token())

    def auth_start(self, _args):
        d = self.form("/login/device/code",{"client_id":CLIENT_ID,"scope":"repo workflow"})
        check(all(k in d for k in ("device_code","user_code","verification_uri","expires_in")), "DEVICE_RESPONSE_INVALID")
        interval = max(5, int(d.get("interval",5)))
        store_json(self.devicefile, dict(device_code=d["device_code"], interval=interval,
                 expires=time.time()+int(d["expires_in"]), next_poll=0))
        return dict(user_code=d["user_code"], verification_uri="https://github.com/login/device",
                    expires_in=d["expires_in"], interval=interval)

    def auth_status(self, _args):
        if self.tokenfile.exists():
            me = self.api("/user")
            return dict(authenticated=True, username=me.get("login"), token="(hidden)")
        try:
            with self.devicefile.open() as f:
                d = json.load(f)
        except FileNotFoundError:
            return dict(authenticated=False,state="NOT_STARTED")
        check(time.time()<d["expires"], "DEVICE_CODE_EXPIRED")
        if time.time()<d.get("next_poll",0):
            return dict(authenticated=False,state="WAITING",retry_after_seconds=int(d["next_poll"]-time.time()+1))
        response = self.form("/login/oauth/access_token", {
            "client_id":CLIENT_ID,"device_code":d["device_code"],
            "grant_type":"urn:ietf:params:oauth:grant-type:device_code"})
        if response.get("access_token"):
            token = response["access_token"]
            check(isinstance(token,str) and len(token)>25, "INVALID_TOKEN_RESPONSE")
            # Validate token against the intended GitHub owner before saving it.
            me = self.request("https://api.github.com/user",token=token)
            check(str(me.get("login","")).lower()==OWNER.lower(), "GITHUB_IDENTITY_MISMATCH")
            store_json(self.tokenfile,dict(access_token=token,username=me["login"]))
            self.devicefile.unlink(missing_ok=True)
            return dict(authenticated=True,username=me["login"],token="(hidden)")
        status = response.get("error","UNKNOWN")
        if status == "slow_down":
            d["interval"] += 5
        elif status not in ("authorization_pending","slow_down"):
            raise GithubProblem("DEVICE_"+str(status).upper())
        d["next_poll"] = time.time()+d["interval"]
        store_json(self.devicefile,d)
        return dict(authenticated=False,state="WAITING",retry_after_seconds=d["interval"])

    def repository(self,a):
        return "/repos/"+repo_ok(a["repo"])

    def repo_list(self,a):
        repos=[]
        for page in range(1,6):
            rows=self.api("/user/repos?per_page=100&page="+str(page)+"&affiliation=owner")
            repos += [dict(full_name=r["full_name"],private=r["private"],default_branch=r["default_branch"])
                      for r in rows if r.get("owner",{}).get("login","").lower()==OWNER.lower()]
            if len(rows)<100: break
        return dict(repositories=repos,truncated=len(repos)>=500)

    def tree_list(self,a):
        repo=self.repository(a)
        ref=ref_ok(a["ref"])
        data=self.api(repo+"/git/trees/"+segment(ref)+"?recursive=1")
        prefix=(path_ok(a["path"]).rstrip("/")+"/") if a.get("path") else ""
        entries=[dict(path=x["path"],type=x["type"],sha=x["sha"],size=x.get("size"))
                 for x in data.get("tree",[]) if not prefix or x["path"].startswith(prefix)]
        return dict(entries=entries[:500],truncated=data.get("truncated",False) or len(entries)>500)

    def file_get(self,a):
        repo=self.repository(a)
        p=path_ok(a["path"])
        ref=ref_ok(a["ref"])
        d=self.api(repo+"/contents/"+"/".join(segment(x) for x in p.split("/"))+"?ref="+segment(ref))
        check(d.get("type")=="file" and d.get("encoding")=="base64", "GITHUB_NOT_FILE")
        data=base64.b64decode(d["content"])
        check(len(data)<=MAX_FILE,"GITHUB_FILE_TOO_LARGE")
        try:
            content=data.decode("utf-8")
            return dict(path=p,sha=d["sha"],size_bytes=len(data),encoding="text",content=content)
        except UnicodeDecodeError:
            return dict(path=p,sha=d["sha"],size_bytes=len(data),encoding="base64",content=base64.b64encode(data).decode())

    def files_push(self,a):
        repo=self.repository(a)
        branch=ref_ok(a["branch"])
        message=a["message"]
        check(isinstance(message,str) and 1<=len(message)<=1000,"INVALID_COMMIT_MESSAGE")
        files=a.get("files",[])
        deleted=a.get("delete_paths",[])
        check(isinstance(files,list) and isinstance(deleted,list) and len(files)+len(deleted)<=100 and
              len(files)+len(deleted)>0,"INVALID_FILE_SET")
        seen=set()
        tree=[]
        for item in files:
            p=path_ok(item["path"])
            check(p not in seen,"DUPLICATE_PATH")
            seen.add(p)
            has_text="content" in item
            has_b64="content_base64" in item
            check(has_text!=has_b64,"CONTENT_REQUIRED")
            data=(str(item["content"]).encode("utf-8") if has_text
                  else base64.b64decode(item["content_base64"],validate=True))
            check(len(data)<=MAX_FILE,"GITHUB_FILE_TOO_LARGE")
            blob=self.api(repo+"/git/blobs","POST",{"content":base64.b64encode(data).decode(),"encoding":"base64"})
            tree.append(dict(path=p,mode="100644",type="blob",sha=blob["sha"]))
        for p in deleted:
            p=path_ok(p)
            check(p not in seen,"DUPLICATE_PATH")
            seen.add(p)
            tree.append(dict(path=p,mode="100644",type="blob",sha=None))
        head=self.api(repo+"/git/ref/heads/"+segment(branch))["object"]["sha"]
        commit=self.api(repo+"/git/commits/"+head)
        newtree=self.api(repo+"/git/trees","POST",{"base_tree":commit["tree"]["sha"],"tree":tree})
        made=self.api(repo+"/git/commits","POST",{"message":message,"tree":newtree["sha"],"parents":[head]})
        check(self.api(repo+"/git/ref/heads/"+segment(branch))["object"]["sha"]==head,"GITHUB_BRANCH_MOVED")
        self.api(repo+"/git/refs/heads/"+segment(branch),"PATCH",{"sha":made["sha"],"force":False})
        return dict(commit_sha=made["sha"],parent_sha=head,blob_shas={
            x["path"]:x["sha"] for x in tree if x["sha"] is not None})

    def file_delete(self,a):
        check(a.get("confirm") is True,"CONFIRM_REQUIRED")
        return self.files_push(dict(repo=a["repo"],branch=a["branch"],message=a["message"],
                                   files=[],delete_paths=[a["path"]]))

    def branch_list(self,a):
        repo=self.repository(a)
        rows=self.api(repo+"/branches?per_page=100")
        return dict(branches=[dict(name=x["name"],sha=x["commit"]["sha"]) for x in rows],
                    truncated=len(rows)>=100)

    def branch_create(self,a):
        repo=self.repository(a)
        name=ref_ok(a["name"])
        frm=ref_ok(a["from_ref"])
        try:
            sha=self.api(repo+"/git/ref/heads/"+segment(frm))["object"]["sha"]
        except GithubProblem:
            sha=self.api(repo+"/commits/"+segment(frm))["sha"]
        result=self.api(repo+"/git/refs","POST",{"ref":"refs/heads/"+name,"sha":sha})
        return dict(name=name,sha=result["object"]["sha"])

    def commit_list(self,a):
        repo=self.repository(a)
        ref=ref_ok(a["ref"])
        q="?sha="+segment(ref)+"&per_page=100"
        if a.get("path"):
            q+="&path="+segment(path_ok(a["path"]))
        rows=self.api(repo+"/commits"+q)
        return dict(commits=[dict(sha=x["sha"],message=x["commit"]["message"].split("\n",1)[0])
                             for x in rows])

    def commit_get(self,a):
        repo=self.repository(a)
        d=self.api(repo+"/commits/"+segment(ref_ok(a["sha"])))
        return dict(sha=d["sha"],message=d["commit"]["message"],parents=[p["sha"] for p in d.get("parents",[])],
                    files=[dict(path=x["filename"],status=x["status"],sha=x.get("sha")) for x in d.get("files",[])][:100])

    def compare(self,a):
        repo=self.repository(a)
        d=self.api(repo+"/compare/"+segment(ref_ok(a["base"]))+"..."+segment(ref_ok(a["head"])))
        return dict(status=d.get("status"),ahead_by=d.get("ahead_by"),behind_by=d.get("behind_by"),
                    files=[dict(path=x["filename"],status=x["status"]) for x in d.get("files",[])][:200])

    def pr_create(self,a):
        repo=self.repository(a)
        d=self.api(repo+"/pulls","POST",{"title":a["title"],"body":a.get("body",""),
                              "head":ref_ok(a["head"]),"base":ref_ok(a["base"]),
                              "draft":bool(a.get("draft",False))})
        return dict(number=d["number"],url=d["html_url"],state=d["state"])

    def pr_list(self,a):
        repo=self.repository(a)
        state=a.get("state","open")
        check(state in ("open","closed","all"),"INVALID_PR_STATE")
        rows=self.api(repo+"/pulls?state="+state+"&per_page=100")
        return dict(pull_requests=[dict(number=x["number"],title=x["title"],
                      state=x["state"],url=x["html_url"],draft=x["draft"]) for x in rows])

    def pr_merge(self,a):
        check(a.get("confirm") is True,"CONFIRM_REQUIRED")
        repo=self.repository(a)
        number=int(a["number"])
        check(number>0,"INVALID_PR_NUMBER")
        mode=a.get("method","merge")
        check(mode in ("merge","squash","rebase"),"INVALID_PR_METHOD")
        d=self.api(repo+"/pulls/"+str(number)+"/merge","PUT",{"merge_method":mode})
        return dict(merged=bool(d["merged"]),sha=d.get("sha"))

    def search_code(self,a):
        query=a["query"]
        check(isinstance(query,str) and 1<=len(query)<=300,"INVALID_QUERY")
        # Scoped to owner's repos by default. User can search another own repo.
        if "repo:" not in query:
            query += " user:"+OWNER
        d=self.api("/search/code?q="+segment(query)+"&per_page=40")
        return dict(total_count=d.get("total_count"),matches=[
            dict(repo=x.get("repository",{}).get("full_name"),path=x["path"],url=x.get("html_url"))
            for x in d.get("items",[])])

    def call(self,name,a):
        methods={
            "github_auth_start":self.auth_start, "github_auth_status":self.auth_status,
            "github_repo_list":self.repo_list, "github_tree_list":self.tree_list,
            "github_file_get":self.file_get,"github_files_push":self.files_push,
            "github_file_delete":self.file_delete, "github_branch_list":self.branch_list,
            "github_branch_create":self.branch_create,"github_commit_list":self.commit_list,
            "github_commit_get":self.commit_get,"github_compare":self.compare,
            "github_pr_create":self.pr_create,"github_pr_list":self.pr_list,
            "github_pr_merge":self.pr_merge,"github_search_code":self.search_code}
        check(name in methods,"UNKNOWN_GITHUB_TOOL")
        return methods[name](a)
