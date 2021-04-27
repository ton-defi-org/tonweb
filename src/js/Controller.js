import {FakeTransport} from "./FakeLedgerTransport.js";

let contentScriptPort = null;
let popupPort = null;
const queueToPopup = [];

const showExtensionPopup = () => {
    const cb = (currentPopup) => {
        this._popupId = currentPopup.id
    };
    const creation = chrome.windows.create({
        url: 'popup.html',
        type: 'popup',
        width: 400,
        height: 600,
        top: 0,
        left: window.innerWidth - 400,
    }, cb);
}

const BN = TonWeb.utils.BN;
const nacl = TonWeb.utils.nacl;
const Address = TonWeb.utils.Address;
const formatNanograms = TonWeb.utils.fromNano;

/**
 * todo: duplicate
 * @return  String
 */
async function hash(s) {
    const bytes = new TextEncoder().encode(s);
    return TonWeb.utils.bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// ENCRYPTION

/**
 * @param plaintext {string}
 * @param password {string}
 * @return {Promise<string>}
 */
async function encrypt(plaintext, password) {
    const pwUtf8 = new TextEncoder().encode(password);                                 // encode password as UTF-8
    const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8);                      // hash the password

    const iv = crypto.getRandomValues(new Uint8Array(12));                             // get 96-bit random iv

    const alg = {name: 'AES-GCM', iv: iv};                                           // specify algorithm to use

    const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']); // generate key from pw

    const ptUint8 = new TextEncoder().encode(plaintext);                               // encode plaintext as UTF-8
    const ctBuffer = await crypto.subtle.encrypt(alg, key, ptUint8);                   // encrypt plaintext using key

    const ctArray = Array.from(new Uint8Array(ctBuffer));                              // ciphertext as byte array
    const ctStr = ctArray.map(byte => String.fromCharCode(byte)).join('');             // ciphertext as string
    const ctBase64 = btoa(ctStr);                                                      // encode ciphertext as base64

    const ivHex = Array.from(iv).map(b => ('00' + b.toString(16)).slice(-2)).join(''); // iv as hex string

    return ivHex + ctBase64;                                                             // return iv+ciphertext
}

/**
 * @param ciphertext {string}
 * @param password {string}
 * @return {Promise<string>}
 */
async function decrypt(ciphertext, password) {
    const pwUtf8 = new TextEncoder().encode(password);                                  // encode password as UTF-8
    const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8);                       // hash the password

    const iv = ciphertext.slice(0, 24).match(/.{2}/g).map(byte => parseInt(byte, 16));   // get iv from ciphertext

    const alg = {name: 'AES-GCM', iv: new Uint8Array(iv)};                            // specify algorithm to use

    const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['decrypt']);  // use pw to generate key

    const ctStr = atob(ciphertext.slice(24));                                           // decode base64 ciphertext
    const ctUint8 = new Uint8Array(ctStr.match(/[\s\S]/g).map(ch => ch.charCodeAt(0))); // ciphertext as Uint8Array
    // note: why doesn't ctUint8 = new TextEncoder().encode(ctStr) work?

    const plainBuffer = await crypto.subtle.decrypt(alg, key, ctUint8);                 // decrypt ciphertext using key
    const plaintext = new TextDecoder().decode(plainBuffer);                            // decode password from UTF-8

    return plaintext;                                                                   // return the plaintext
}

// CONTROLLER

class Controller {
    constructor() {
        /** @type {string} */
        this.myAddress = null;
        /** @type {string} */
        this.publicKeyHex = null;
        /** @type {string[]} */
        this.myMnemonicWords = null;
        /** @type   {BN | null} */
        this.balance = null;
        /** @type {WalletContract} */
        this.walletContract = null;
        this.transactions = [];
        this.updateIntervalId = 0;
        this.lastTransactionTime = 0;
        this.isContractInitialized = false;
        this.sendingData = null;
        this.processingVisible = false;

        this.ledgerApp = null;
        this.isLedger = false;

        if (window.view) {
            window.view.controller = this;
        }

        this.ton = new TonWeb();
        this.myAddress = localStorage.getItem('address');
        if (!this.myAddress || !localStorage.getItem('words') || !localStorage.getItem('pwdHash')) {
            localStorage.clear();
            this.sendToView('showScreen', {name: 'start'})
        } else {
            if (localStorage.getItem('isLedger') === 'true') {
                this.isLedger = true;
                this.publicKeyHex = localStorage.getItem('publicKey');
                this.sendToView('setIsLedger', this.isLedger);
            }

            this.showMain();
        }
    }

    /**
     * @param words {string[]}
     * @return {Promise<string>}
     */
    static async wordsToPrivateKey(words) {
        const keyPair = await TonWeb.mnemonic.mnemonicToKeyPair(words);
        return TonWeb.utils.bytesToBase64(keyPair.secretKey.slice(0, 32));
    }

    /**
     * @param words {string[]}
     * @param password  {string}
     * @return {Promise<void>}
     */
    static async saveWords(words, password) {
        localStorage.setItem('words', await encrypt(words.join(','), password));
    }

    /**
     * @param password  {string}
     * @return {Promise<string[]>}
     */
    static async loadWords(password) {
        return (await decrypt(localStorage.getItem('words'), password)).split(',');
    }

    async getWallet() {
        return this.ton.provider.getWalletInfo(this.myAddress);
    }

    checkContractInitialized(getWalletResponse) {
        return (getWalletResponse.account_state == "active") && getWalletResponse.seqno;
    }

    /**
     * @return {BN} in nanograms
     */
    getBalance(getWalletResponse) {
        return new BN(getWalletResponse.balance);
    }

    async getTransactions(limit = 20) {

        function getComment(msg) {
            if (!msg.msg_data) return '';
            if (msg.msg_data['@type'] !== 'msg.dataText') return '';
            const base64 = msg.msg_data.text;
            return new TextDecoder().decode(TonWeb.utils.base64ToBytes(base64));
        }

        const arr = [];
        const transactions = await this.ton.getTransactions(this.myAddress, limit);
        for (let t of transactions) {
            let amount = new BN(t.in_msg.value);
            for (let outMsg of t.out_msgs) {
                amount = amount.sub(new BN(outMsg.value));
            }
            //amount = amount.sub(new BN(t.fee));

            let from_addr = "";
            let to_addr = "";
            let comment = "";
            if (t.in_msg.source) { // internal message with grams, set source
                from_addr = t.in_msg.source;
                to_addr = t.in_msg.destination;
                comment = getComment(t.in_msg);
            } else if (t.out_msgs.length) { // external message, we sending grams
                from_addr = t.out_msgs[0].source;
                to_addr = t.out_msgs[0].destination;
                comment = getComment(t.out_msgs[0]);
                //TODO support many out messages. We need to show separate outgoing payment for each? How to show fees?
            } else {
                // Deploying wallet contract onchain
            }

            if (to_addr) {
                arr.push({
                    amount: amount.toString(),
                    from_addr: from_addr,
                    to_addr: to_addr,
                    fee: t.fee.toString(),
                    storageFee: t.storage_fee.toString(),
                    otherFee: t.other_fee.toString(),
                    comment: comment,
                    date: t.utime * 1000
                });
            }
        }
        return arr;
    }

    /**
     * @param privateKey    {String}  Base64 private key
     * @return Promise<{send: Function, estimateFee: Function}>
     */
    deployContract(privateKey) {
        const keyPair = nacl.sign.keyPair.fromSeed(TonWeb.utils.base64ToBytes(privateKey));
        return this.walletContract.deploy(keyPair.secretKey);
    }

    /**
     * @param toAddress {String}  Destination address in any format
     * @param amount    {BN}  Transfer value in nanograms
     * @param comment   {String}  Transfer comment
     * @param keyPair    nacl.KeyPair
     * @return Promise<{send: Function, estimateFee: Function}>
     */
    async sign(toAddress, amount, comment, keyPair) {
        const wallet = await this.getWallet(this.myAddress);
        let seqno = wallet.seqno;
        if (!seqno) seqno = 1; // if contract not initialized, use seqno = 1

        const secretKey = keyPair ? keyPair.secretKey : null;
        return this.walletContract.methods.transfer({
            secretKey: secretKey,
            toAddress: toAddress,
            amount: amount,
            seqno: seqno,
            payload: comment,
            sendMode: 3
        });
    }

    // CREATE WALLET

    async showCreated() {
        this.sendToView('showScreen', {name: 'created'});
        this.sendToView('disableCreated', true);
        this.myMnemonicWords = await TonWeb.mnemonic.generateMnemonic();
        const privateKey = await Controller.wordsToPrivateKey(this.myMnemonicWords);
        const keyPair = nacl.sign.keyPair.fromSeed(TonWeb.utils.base64ToBytes(privateKey));
        this.walletContract = this.ton.wallet.create({
            publicKey: keyPair.publicKey,
            wc: 0
        });
        this.myAddress = (await this.walletContract.getAddress()).toString(true, true, true);
        localStorage.setItem('walletVersion', this.ton.wallet.defaultVersion);
        this.sendToView('disableCreated', false);
    }

    async createPrivateKey() {
        this.showBackup(this.myMnemonicWords);
    }

    // BACKUP WALLET

    onBackupWalletClick() {
        this.afterEnterPassword = async password => {
            const mnemonicWords = await Controller.loadWords(password);
            this.showBackup(mnemonicWords);
        };
        this.sendToView('showPopup', {name: 'enterPassword'});
    }

    showBackup(words) {
        this.sendToView('showScreen', {name: 'backup', words});
    }

    onBackupDone() {
        if (localStorage.getItem('words')) {
            this.sendToView('showScreen', {name: 'main'});
        } else {
            this.showCreatePassword();
        }
    }

    // IMPORT LEDGER

    async createLedger(transportType) {
        let transport;

        switch (transportType) {
            case 'hid':
                // transport = new FakeTransport(this.ton);
                transport = await TonWeb.ledger.TransportWebHID.create();
                break;
            case 'ble':
                transport = await TonWeb.ledger.BluetoothTransport.create();
                break;
            default:
                throw new Error('unknown transportType' + transportType)
        }

        transport.setDebugMode(true);
        this.isLedger = true;
        this.ledgerApp = new TonWeb.ledger.AppTon(transport, this.ton);
        console.log('ledgerAppConfig=', await this.ledgerApp.getAppConfiguration());
        const {address, wallet, publicKey} = await this.ledgerApp.getAddress(0, false); // todo: можно сохранять publicKey и не запрашивать это
        this.walletContract = wallet;
        this.myAddress = address.toString(true, true, true);
        this.publicKeyHex = TonWeb.utils.bytesToHex(publicKey);
    }

    async importLedger(transportType) {
        await this.createLedger(transportType);
        localStorage.setItem('walletVersion', this.walletContract.getName());
        localStorage.setItem('address', this.myAddress);
        localStorage.setItem('isLedger', 'true');
        localStorage.setItem('ledgerTransportType', transportType);
        localStorage.setItem('pwdHash', 'ledger');
        localStorage.setItem('words', 'ledger');
        localStorage.setItem('publicKey', this.publicKeyHex);
        this.sendToView('setIsLedger', this.isLedger);
        this.sendToView('showScreen', {name: 'readyToGo'});
    }

    // IMPORT WALLET

    showImport() {
        this.sendToView('showScreen', {name: 'import'});
    }

    async import(words) {
        this.myMnemonicWords = words;
        if (this.myMnemonicWords) {
            const privateKey = await Controller.wordsToPrivateKey(this.myMnemonicWords);
            const keyPair = nacl.sign.keyPair.fromSeed(TonWeb.utils.base64ToBytes(privateKey));

            let hasBalance = [];

            for (let WalletClass of this.ton.wallet.list) {
                const wallet = new WalletClass(this.ton.provider, {
                    publicKey: keyPair.publicKey,
                    wc: 0
                });
                const walletAddress = (await wallet.getAddress()).toString(true, true, true);
                const walletInfo = await this.ton.provider.getWalletInfo(walletAddress);
                const walletBalance = this.getBalance(walletInfo);
                if (walletBalance.gt(new BN(0))) {
                    hasBalance.push({balance: walletBalance, clazz: WalletClass});
                }
                console.log(wallet.getName(), walletAddress, walletInfo, walletBalance.toString());
            }

            let walletClass = this.ton.wallet.default;

            if (hasBalance.length > 0) {
                hasBalance.sort((a, b) => {
                    return a.balance.cmp(b.balance);
                });
                walletClass = hasBalance[hasBalance.length - 1].clazz;
            }

            await this.importImpl(keyPair, walletClass);
        }
    }

    async importImpl(keyPair, WalletClass) {
        this.walletContract = new WalletClass(this.ton.provider, {
            publicKey: keyPair.publicKey,
            wc: 0
        });
        this.myAddress = (await this.walletContract.getAddress()).toString(true, true, true);
        localStorage.setItem('walletVersion', this.walletContract.getName());
        this.showCreatePassword();
    }

    // PASSWORD

    showCreatePassword() {
        this.sendToView('showScreen', {name: 'createPassword'});
    }

    async savePrivateKey(password) {
        this.isLedger = false;
        localStorage.setItem('isLedger', 'false');
        localStorage.setItem('address', this.myAddress);
        await Controller.saveWords(this.myMnemonicWords, password);
        const passwordHash = await hash(password);
        localStorage.setItem('pwdHash', passwordHash);
        this.myMnemonicWords = null;

        this.sendToView('setIsLedger', this.isLedger);
        this.sendToView('setPasswordHash', passwordHash);
        this.sendToView('showScreen', {name: 'readyToGo'});
    }

    async onChangePassword(oldPassword, newPassword) {
        if (await hash(oldPassword) !== localStorage.getItem('pwdHash')) {
            return;
        }

        const words = await Controller.loadWords(oldPassword);
        await Controller.saveWords(words, newPassword);
        const passwordHash = await hash(newPassword);
        localStorage.setItem('pwdHash', passwordHash);
        this.sendToView('setPasswordHash', passwordHash);

        this.sendToView('closePopup');
    }

    async onEnterPassword(password) {
        if (await hash(password) === localStorage.getItem('pwdHash')) {
            this.afterEnterPassword(password);
        }
    }

    // MAIN

    showMain() {
        this.sendToView('showScreen', {name: 'main', myAddress: this.myAddress});
        this.sendToView('setPasswordHash', localStorage.getItem('pwdHash'));
        this.sendToView('setPublicKey', this.publicKeyHex);
        if (!this.walletContract) {
            const walletVersion = localStorage.getItem('walletVersion');
            const walletClass = walletVersion ? this.ton.wallet.all[walletVersion] : this.ton.wallet.default;

            this.walletContract = new walletClass(this.ton.provider, {
                address: this.myAddress,
                wc: 0
            });
        }
        this.updateIntervalId = setInterval(() => this.update(), 5000);
        this.update();
        this.sendToDapp('ton_accounts', [this.myAddress]);
    }

    initDapp() {
        this.sendToDapp('ton_accounts', this.myAddress ? [this.myAddress] : []);
    }

    initView() {
        if (!this.myAddress || !localStorage.getItem('words') || !localStorage.getItem('pwdHash')) {
            this.sendToView('showScreen', {name: 'start'})
        } else {
            this.sendToView('showScreen', {name: 'main', myAddress: this.myAddress});
            if (this.balance !== null) {
                this.sendToView('setBalance', {balance: this.balance.toString(), txs: this.transactions});
            }
            this.sendToView('setPasswordHash', localStorage.getItem('pwdHash'));
            this.sendToView('setPublicKey', this.publicKeyHex);
        }
    }

    update() {
        this.getWallet().then(response => {
            const balance = this.getBalance(response);
            const isBalanceChanged = (this.balance === null) || (this.balance.cmp(balance) !== 0);
            this.balance = balance;

            const isContractInitialized = this.checkContractInitialized(response);
            console.log('isBalanceChanged', isBalanceChanged);
            console.log('isContractInitialized', isContractInitialized);

            if (!this.isContractInitialized && isContractInitialized) {
                this.isContractInitialized = true;
                if (this.sendingData) {
                    console.log('try to send', this.sendingData);
                    this.sendQuery(this.sendingData.query);
                }
            }

            if (isBalanceChanged) {
                this.getTransactions().then(txs => {
                    if (txs.length > 0) {
                        this.transactions = txs;
                        const newTxs = txs.filter(tx => Number(tx.date) > this.lastTransactionTime);
                        this.lastTransactionTime = Number(txs[0].date);

                        if (this.processingVisible && this.sendingData) {
                            for (let tx of newTxs) {
                                const txAddr = (new Address(tx.to_addr)).toString(true, true, true);
                                const myAddr = (new Address(this.sendingData.toAddress)).toString(true, true, true);
                                const txAmount = tx.amount;
                                const myAmount = '-' + this.sendingData.amount.toString();

                                if (txAddr === myAddr && txAmount === myAmount) {
                                    this.sendToView('showPopup', {
                                        name: 'done',
                                        message: formatNanograms(this.sendingData.amount) + ' TON have been sent'
                                    });
                                    this.processingVisible = false;
                                    this.sendingData = null;
                                    break;
                                }
                            }
                        }
                    }

                    this.sendToView('setBalance', {balance: balance.toString(), txs});
                });
            } else {
                this.sendToView('setBalance', {balance: balance.toString(), txs: this.transactions});
            }
        });
    }

    async showAddressOnDevice() {
        if (!this.ledgerApp) {
            await this.createLedger(localStorage.getItem('ledgerTransportType') || 'hid');
        }
        const {publicKey} = await this.ledgerApp.getAddress(0, true);
        const hex = TonWeb.utils.bytesToHex(publicKey);
        this.sendToView('setPublicKey', hex);
    }

    // SEND GRAMS

    /**
     * @param amount    {BN}    in nanograms
     * @param toAddress {string}
     * @param comment?  {string}
     * @return {Promise<BN>} in nanograms
     */
    async getFees(amount, toAddress, comment) {
        if (!this.isContractInitialized) {
            return TonWeb.utils.toNano(0.010966001);
        }

        try {
            const query = await this.sign(toAddress, amount, comment, null);
            const all_fees = await query.estimateFee();
            const fees = all_fees.source_fees;
            const in_fwd_fee = new BN(fees.in_fwd_fee);
            const storage_fee = new BN(fees.storage_fee);
            const gas_fee = new BN(fees.gas_fee);
            const fwd_fee = new BN(fees.fwd_fee);

            // const tooltip_text = '<span>External processing fee ' + (fees.in_fwd_fee / 1e9).toString() + ' grams</span></br>' +
            //     '<span>Storage fee ' + (fees.storage_fee / 1e9).toString() + ' grams</span></br>' +
            //     '<span>Gas fee ' + (fees.gas_fee / 1e9).toString() + ' grams</span></br>' +
            //     '<span>Forwarding fees ' + (fees.fwd_fee / 1e9).toString() + ' grams</span>';
            //
            return in_fwd_fee.add(storage_fee).add(gas_fee).add(fwd_fee);
        } catch (err) {
            console.error(err);
            return new BN(0);
        }
    };

    /**
     * @param amount    {BN} in nanograms
     * @param toAddress {string}
     * @param comment?  {string}
     */
    async showSendConfirm(amount, toAddress, comment, needQueue) {
        if (amount.lte(0) || this.balance.lt(amount)) {
            return;
        }
        if (!Address.isValid(toAddress)) {
            return;
        }

        const fee = await this.getFees(amount, toAddress, comment);

        if (this.isLedger) {

            this.sendToView('showPopup', {name: 'processing'}); // todo: show popup with amount, dest address in hex form, and label 'Please approve on device'
            this.processingVisible = true;
            this.send(toAddress, amount, comment, null);

        } else {

            this.afterEnterPassword = async password => {
                const words = await Controller.loadWords(password);
                this.processingVisible = true;
                this.sendToView('showPopup', {name: 'processing'});
                const privateKey = await Controller.wordsToPrivateKey(words);
                this.send(toAddress, amount, comment, privateKey);
            };

            this.sendToView('showPopup', {
                name: 'sendConfirm',
                amount: amount.toString(),
                toAddress: toAddress,
                fee: fee.toString()
            }, needQueue);

        }
    }

    /**
     * @param toAddress {string}
     * @param amount    {BN} in nanograms
     * @param comment   {string}
     * @param privateKey    {string}
     */
    async send(toAddress, amount, comment, privateKey) {
        try {
            if (!this.checkContractInitialized(await this.ton.provider.getWalletInfo(toAddress))) {
                toAddress = (new Address(toAddress)).toString(true, true, false);
            }

            if (this.isLedger) {

                if (!this.ledgerApp) {
                    await this.createLedger(localStorage.getItem('ledgerTransportType') || 'hid');
                }

                const wallet = await this.getWallet(this.myAddress);
                let seqno = wallet.seqno;
                if (!seqno) seqno = 1; // if contract not initialized, use seqno = 1

                const query = await this.ledgerApp.transfer(0, this.walletContract, toAddress, amount, seqno);
                this.sendingData = {toAddress: toAddress, amount: amount, comment: comment, query: query};

                if (this.checkContractInitialized(await this.getWallet())) {
                    this.sendQuery(query);
                } else {
                    console.log('Deploy contract');
                    const result = await this.ledgerApp.deploy(0, this.walletContract);
                    await this.sendQuery(result);
                    // wait for initialization, then send transfer
                }
            } else {

                const keyPair = nacl.sign.keyPair.fromSeed(TonWeb.utils.base64ToBytes(privateKey));
                const query = await this.sign(toAddress, amount, comment, keyPair);
                this.sendingData = {toAddress: toAddress, amount: amount, comment: comment, query: query};

                if (this.checkContractInitialized(await this.getWallet())) {
                    this.sendQuery(query);
                } else {
                    console.log('Deploy contract');
                    const response = await this.deployContract(privateKey).send();
                    if (response["@type"] === "ok") {
                        // wait for initialization, then send transfer
                    } else {
                        this.sendToView('closePopup');
                        alert('Deploy contract error');
                    }
                }
            }
        } catch (e) {
            console.error(e);
            this.sendToView('closePopup');
            alert('Error sending');
        }
    }

    /**
     * @param query - return by sign()
     * @return {Promise<void>}
     */
    async sendQuery(query) {
        console.log('Send');
        const sendResponse = await query.send();
        if (sendResponse["@type"] === "ok") {
            // wait for transaction, then show Done popup
        } else {
            this.sendToView('closePopup');
            alert('Send error');
        }
    }

    // DISCONNECT WALLET

    onDisconnectClick() {
        this.myAddress = null;
        this.publicKeyHex = null;
        this.balance = null;
        this.walletContract = null;
        this.transactions = [];
        this.lastTransactionTime = 0;
        this.isContractInitialized = false;
        this.sendingData = null;
        this.processingVisible = false;
        this.isLedger = false;
        this.ledgerApp = null;
        clearInterval(this.updateIntervalId);
        localStorage.clear();
        this.sendToView('showScreen', {name: 'start'});
        this.sendToDapp('ton_accounts', []);
    }

    // TRANSPORT WITH VIEW

    sendToView(method, params, needQueue) {
        if (window.view) {
            window.view.onMessage(method, params);
        } else {
            const msg = {method, params};
            if (popupPort) {
                popupPort.postMessage(msg);
            } else {
                if (needQueue) {
                    queueToPopup.push(msg);
                }
            }
        }
    }

    onViewMessage(method, params) {
        switch (method) {
            case 'showScreen':
                switch (params.name) {
                    case 'created':
                        this.showCreated();
                        break;
                    case 'import':
                        this.showImport();
                        break;
                    case 'importLedger':
                        this.importLedger(params.transportType);
                        break;
                }
                break;
            case 'import':
                this.import(params.words);
                break;
            case 'createPrivateKey':
                this.createPrivateKey();
                break;
            case 'passwordCreated':
                this.savePrivateKey(params.password);
                break;
            case 'update':
                this.update();
                break;
            case 'showAddressOnDevice':
                this.showAddressOnDevice();
                break;
            case 'onEnterPassword':
                this.onEnterPassword(params.password);
                break;
            case 'onChangePassword':
                this.onChangePassword(params.oldPassword, params.newPassword);
                break;
            case 'onSend':
                this.showSendConfirm(new BN(params.amount), params.toAddress, params.comment);
                break;
            case 'onBackupDone':
                this.onBackupDone();
                break;
            case 'showMain':
                this.showMain();
                break;
            case 'onBackupWalletClick':
                this.onBackupWalletClick();
                break;
            case 'disconnect':
                this.onDisconnectClick();
                break;
            case 'onClosePopup':
                this.processingVisible = false;
                break;
        }
    }

    // TRANSPORT WITH DAPP

    sendToDapp(method, params) {
        if (contentScriptPort) {
            contentScriptPort.postMessage(JSON.stringify({
                type: 'gramWalletAPI',
                message: {jsonrpc: '2.0', method: method, params: params}
            }));
        }
    }

    async onDappMessage(method, params) {
        // https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1193.md
        // https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1102.md

        switch (method) {
            case 'ton_requestAccounts':
                return (this.myAddress ? [this.myAddress] : []);
            case 'ton_getBalance':
                return (this.balance ? this.balance.toString() : '');
            case 'ton_sendTransaction':
                const param = params[0];
                const needQueue = !popupPort;
                if (!popupPort) {
                    showExtensionPopup();
                }
                this.showSendConfirm(new BN(param.value), param.to, param.data, needQueue);
                return true;
        }
    }
}

const controller = new Controller();

if (chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener(port => {
        if (port.name === 'gramWalletContentScript') {
            contentScriptPort = port;
            contentScriptPort.onMessage.addListener(async msg => {
                if (!msg.message) return;
                const result = await controller.onDappMessage(msg.message.method, msg.message.params);
                if (contentScriptPort) {
                    contentScriptPort.postMessage(JSON.stringify({
                        type: 'gramWalletAPI',
                        message: {jsonrpc: '2.0', id: msg.message.id, method: msg.message.method, result}
                    }));
                }
            });
            contentScriptPort.onDisconnect.addListener(() => {
                contentScriptPort = null;
            });
            controller.initDapp()
        } else if (port.name === 'gramWalletPopup') {
            popupPort = port;
            popupPort.onMessage.addListener(function (msg) {
                controller.onViewMessage(msg.method, msg.params);
            });
            popupPort.onDisconnect.addListener(() => {
                popupPort = null;
            });
            controller.initView()
            queueToPopup.forEach(msg => popupPort.postMessage(msg));
            queueToPopup.length = 0;
        }
    });
}