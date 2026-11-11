public with sharing class ErpClient {
    public static void send(Policy__c p) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:ERP/orders');
        Http h = new Http();
        HttpRequest other = new HttpRequest();
        other.setEndpoint('https://api.partner.example/v1?apikey=K1_SECRET');
        // req.setEndpoint('https://commented.example.com');
        EventBus.publish(new Policy_Sync__e(Policy__c = p.Id));
    }
}
